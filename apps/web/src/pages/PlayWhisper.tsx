import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MutableRefObject,
  type ReactNode
} from "react";
import { API_BASE_URL, api, ApiClientError } from "../lib/api.js";
import type { WhisperJobSummary, WhisperModel } from "../types.js";

const POLL_MS = 3000;
const FETCH_TIMEOUT_MS = 8000;
const MODELS_TIMEOUT_MS = 2500;
const JOBS_TIMEOUT_MS = 5000;
const LANG_OPTIONS = ["auto", "ja", "en", "zh", "ko", "fr", "de", "es", "it", "pt", "ru"];

type RequestTracker = {
  id: number;
  controller: AbortController | null;
};

type ModelsPhase = "idle" | "fetching" | "got-response" | "read-text" | "parsed-json" | "done" | "error";
type JobsPhase = "idle" | "fetching" | "done" | "error" | "timeout" | "aborted";
type JobDetailsState = Record<string, WhisperJobSummary | undefined>;

export default function PlayWhisperPage() {
  const [models, setModels] = useState<WhisperModel[]>([]);
  const [defaultLanguage, setDefaultLanguage] = useState("auto");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedLanguage, setSelectedLanguage] = useState("auto");
  const [file, setFile] = useState<File | null>(null);
  const [jobs, setJobs] = useState<WhisperJobSummary[]>([]);
  const [jobsFilter, setJobsFilter] = useState<"ALL" | "ACTIVE" | "DONE" | "FAILED" | "CANCELLED">("ALL");
  const [jobDetails, setJobDetails] = useState<JobDetailsState>({});
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(true);
  const [creatingJob, setCreatingJob] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [showModelsDebug, setShowModelsDebug] = useState(false);
  const [modelsFetchAttempt, setModelsFetchAttempt] = useState(0);
  const [modelsPhase, setModelsPhase] = useState<ModelsPhase>("idle");
  const [modelsLastRequestUrl, setModelsLastRequestUrl] = useState<string | null>(null);
  const [modelsLastHttpStatus, setModelsLastHttpStatus] = useState<number | null>(null);
  const [modelsLastFetchError, setModelsLastFetchError] = useState<string | null>(null);
  const [modelsLastUpdatedAt, setModelsLastUpdatedAt] = useState<string | null>(null);
  const [modelsLastRawText, setModelsLastRawText] = useState<string | null>(null);
  const [modelsLastPayload, setModelsLastPayload] = useState<any | null>(null);
  const [modelsExtractedCount, setModelsExtractedCount] = useState<number | null>(null);
  const [jobsFetchAttempt, setJobsFetchAttempt] = useState(0);
  const [jobsPhase, setJobsPhase] = useState<JobsPhase>("idle");
  const [jobsLastHttpStatus, setJobsLastHttpStatus] = useState<number | null>(null);
  const [jobsLastUpdatedAt, setJobsLastUpdatedAt] = useState<string | null>(null);
  const [jobsLastRawText, setJobsLastRawText] = useState<string | null>(null);
  const [jobsLastPayload, setJobsLastPayload] = useState<any | null>(null);
  const [jobsLastFetchError, setJobsLastFetchError] = useState<string | null>(null);
  const [showJobsDebug, setShowJobsDebug] = useState(false);

  const modelsRequest = useRef<RequestTracker>({ id: 0, controller: null });
  const modelsInFlightIdRef = useRef<number | null>(null);
  const modelsRequestIdRef = useRef(0);
  const jobsRequest = useRef<RequestTracker>({ id: 0, controller: null });
  const jobsRequestIdRef = useRef(0);
  const mounted = useRef(true);
  const userChangedLanguage = useRef(false);

  const isModelsReady = Array.isArray(models) && models.length > 0;
  const showModelLoading = !isModelsReady && !modelsError;
  const showJobsLoading = jobs.length === 0 && jobsPhase === "fetching";

  const filteredJobs = useMemo(() => {
    switch (jobsFilter) {
      case "ACTIVE":
        return jobs.filter((job) => job.status === "queued" || job.status === "running");
      case "DONE":
        return jobs.filter((job) => job.status === "succeeded");
      case "FAILED":
        return jobs.filter((job) => job.status === "failed");
      case "CANCELLED":
        return jobs.filter((job) => job.status === "cancelled");
      default:
        return jobs;
    }
  }, [jobs, jobsFilter]);

  const openJob = useMemo(() => {
    if (!openJobId) return null;
    return jobs.find((job) => job.id === openJobId) ?? null;
  }, [jobs, openJobId]);

  useEffect(() => () => {
    mounted.current = false;
    abortTracker(modelsRequest);
    abortTracker(jobsRequest);
  }, []);

  const loadModels = useCallback(async () => {
    const url = `${API_BASE_URL}/api/whisper/models?t=${Date.now()}`;
    setLoadingModels(true);
    setError(null);
    setModelsError(null);
    setModelsPhase("fetching");
    setModelsFetchAttempt((prev) => prev + 1);
    setModelsLastRequestUrl(url);
    setModelsLastHttpStatus(null);
    setModelsLastFetchError(null);
    setModelsLastRawText(null);
    setModelsLastPayload(null);
    setModelsExtractedCount(null);

    const { controller, timeout } = buildAbort(MODELS_TIMEOUT_MS);
    const requestId = modelsRequestIdRef.current + 1;
    modelsRequestIdRef.current = requestId;
    abortTracker(modelsRequest);
    modelsRequest.current = { id: requestId, controller };
    modelsInFlightIdRef.current = requestId;
    try {
      const res = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (modelsInFlightIdRef.current !== requestId) return;
      setModelsPhase("got-response");
      setModelsLastHttpStatus(res.status);

      const text = await res.text();
      if (modelsInFlightIdRef.current !== requestId) return;
      setModelsPhase("read-text");
      setModelsLastRawText(text ? text.slice(0, 1000) : "");

      let json: any = null;
      if (text) {
        try {
          json = JSON.parse(text);
          setModelsPhase("parsed-json");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setModelsLastFetchError(`JSON parse failed: ${message}`);
          setModelsPhase("error");
          setModelsError("モデル一覧の取得に失敗しました（JSON parse error）");
          return;
        }
      } else {
        setModelsPhase("parsed-json");
      }

      setModelsLastPayload(json);
      const list = Array.isArray(json?.data?.models) ? (json.data.models as WhisperModel[]) : [];
      const defaultLang = LANG_OPTIONS.includes(json?.data?.defaultLanguage) ? json.data.defaultLanguage : "auto";
      setModelsExtractedCount(list.length);

      if (!res.ok) {
        const message = json?.error?.message || `HTTP ${res.status}`;
        setModelsError(message);
        setModelsPhase("error");
        return;
      }

      setModels(list);
      if (list.length > 0 && !selectedModel) {
        setSelectedModel(list[0].file);
      }
      setDefaultLanguage(defaultLang);
      if (!userChangedLanguage.current) {
        setSelectedLanguage(defaultLang);
      }
      setModelsPhase("done");
    } catch (err) {
      if (modelsInFlightIdRef.current !== requestId) return;
      if (isAbortError(err)) {
        setModelsPhase("error");
        setModelsLastFetchError("timeout/abort");
        setModelsError("モデル取得がタイムアウトまたは中断されました。");
        return;
      }
      const message = extractError(err);
      setModelsLastFetchError(message);
      if (mounted.current) {
        setModelsError(message);
        setModelsPhase("error");
      }
    } finally {
      clearTimeout(timeout);
      if (mounted.current && modelsInFlightIdRef.current === requestId) {
        setLoadingModels(false);
        setModelsLastUpdatedAt(new Date().toISOString());
        modelsInFlightIdRef.current = null;
      }
      abortIfSame(modelsRequest, controller);
    }
  }, [selectedModel]);

  useEffect(() => {
    if (!selectedModel && isModelsReady) {
      setSelectedModel(models[0].file);
    }
  }, [isModelsReady, models, selectedModel]);

  const pollJobs = useCallback(async () => {
    const { controller, timeout } = buildAbort(JOBS_TIMEOUT_MS);
    const requestId = jobsRequestIdRef.current + 1;
    jobsRequestIdRef.current = requestId;
    abortTracker(jobsRequest);
    jobsRequest.current = { id: requestId, controller };
    setJobsFetchAttempt((prev) => prev + 1);
    setJobsPhase("fetching");
    setJobsLastHttpStatus(null);
    setJobsLastRawText(null);
    setJobsLastPayload(null);
    setJobsLastFetchError(null);
    const url = `${API_BASE_URL}/api/whisper/jobs?t=${Date.now()}`;
    try {
      const res = await fetch(url, { cache: "no-store", signal: controller.signal });
      setJobsLastHttpStatus(res.status);
      const text = await res.text();
      setJobsLastRawText(text ? text.slice(0, 1000) : "");
      let json: any = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch (err) {
          setJobsLastFetchError(err instanceof Error ? err.message : String(err));
          setJobsPhase("error");
          setJobsLastUpdatedAt(new Date().toISOString());
          return;
        }
      }
      setJobsLastPayload(json);
      if (!res.ok) {
        setJobsLastFetchError(json?.error?.message || `HTTP ${res.status}`);
        setJobsPhase("error");
        setJobsLastUpdatedAt(new Date().toISOString());
        return;
      }
      const list = Array.isArray(json?.data?.jobs) ? (json.data.jobs as WhisperJobSummary[]) : [];
      setJobs(list);
      setJobsPhase("done");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setJobsPhase("timeout");
        setJobsLastFetchError("AbortError(timeout)");
      } else {
        const msg = extractError(err);
        setJobsPhase("error");
        setJobsLastFetchError(msg);
      }
    } finally {
      clearTimeout(timeout);
      setJobsLastUpdatedAt(new Date().toISOString());
      abortIfSame(jobsRequest, controller);
    }
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const loop = async () => {
      if (cancelled) return;
      await pollJobs();
      if (cancelled) return;
      timer = setTimeout(loop, POLL_MS);
    };
    loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollJobs]);

  useEffect(() => {
    // keep jobDetails in sync with latest jobs payload for expanded items
    setJobDetails((state: JobDetailsState) => {
      const updated: JobDetailsState = { ...state };
      expandedJobs.forEach((jobId) => {
        const job = jobs.find((j) => j.id === jobId);
        if (job) {
          updated[jobId] = job;
        }
      });
      return updated;
    });
  }, [jobs, expandedJobs]);

  const handleCreateJob = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) {
      setError("音声ファイルを選択してください。");
      return;
    }
    if (!selectedModel) {
      setError("モデルを選択してください。");
      return;
    }
    setCreatingJob(true);
    setError(null);
    setStatusMessage(null);
    const { controller, timeout } = buildAbort(FETCH_TIMEOUT_MS);
    try {
      const data = await api.createWhisperJob(
        { file, modelFile: selectedModel, language: selectedLanguage || defaultLanguage || "auto" },
        { signal: controller.signal }
      );
      setStatusMessage("ジョブを作成しました。");
      setJobs((prev) => [data.job, ...prev]);
      setFile(null);
    } catch (err) {
      if (!isAbortError(err)) setError(extractError(err));
    } finally {
      clearTimeout(timeout);
      setCreatingJob(false);
    }
  };

  const handleCancelJob = async (jobId: string) => {
    try {
      await api.cancelWhisperJob(jobId);
      setStatusMessage("キャンセル要求を送信しました。");
      await pollJobs();
    } catch (err) {
      setError(extractError(err));
    }
  };

  const toggleJobDetails = (jobId: string) => {
    setExpandedJobs((prev: Set<string>) => {
      const next = new Set(prev);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
        if (!jobDetails[jobId]) {
          const found = jobs.find((j) => j.id === jobId);
          if (found) {
            setJobDetails((state: JobDetailsState) => ({
              ...state,
              [jobId]: found
            }));
          }
        }
      }
      const nextOpen = next.has(jobId) ? jobId : (next.values().next().value as string | undefined) ?? null;
      setOpenJobId(nextOpen);
      return next;
    });
  };

  const handleDeleteJob = async (job: WhisperJobSummary) => {
    if (!window.confirm("このジョブを削除しますか？（実行中ジョブは削除できません）")) return;
    try {
      await api.deleteWhisperJob(job.id);
      setJobs((prev) => prev.filter((j) => j.id !== job.id));
      setExpandedJobs((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
      setJobDetails((state: JobDetailsState) => {
        const { [job.id]: _omit, ...rest } = state;
        return rest;
      });
      if (openJobId === job.id) {
        setOpenJobId(null);
      }
      setStatusMessage("ジョブを削除しました。");
    } catch (err) {
      setError(extractError(err));
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Play</p>
          <h1 className="text-3xl font-semibold">Whisper</h1>
          <p className="text-sm text-slate-400">ローカル whisper.cpp で音声を文字起こしします。</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            className="accent-emerald-400"
            checked={showModelsDebug}
            onChange={(e) => setShowModelsDebug(e.target.checked)}
          />
          Models Debug
        </label>
      </header>

      {error && <Banner tone="error" message={error} />}
      {statusMessage && !error && <Banner tone="info" message={statusMessage} />}

      <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg">
        <h2 className="text-xl font-semibold text-white">ジョブ作成</h2>
        <p className="text-sm text-slate-400">モデル・言語を選び、音声ファイルをアップロードします。</p>
        <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={handleCreateJob}>
          <label className="block text-sm">
            <span className="text-slate-300">Model</span>
            <select
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.target.value)}
              disabled={showModelLoading || models.length === 0 || creatingJob}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none disabled:opacity-50"
            >
              {models.length === 0 && <option value="">モデルなし</option>}
              {models.map((model) => (
                <option key={model.file} value={model.file}>
                  {model.file}
                </option>
              ))}
            </select>
            {modelsError && <p className="mt-1 text-xs text-red-300">{modelsError}</p>}
          </label>
          <label className="block text-sm">
            <span className="text-slate-300">Language preset</span>
            <select
              value={selectedLanguage}
              onChange={(event) => {
                userChangedLanguage.current = true;
                setSelectedLanguage(event.target.value);
              }}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
            >
              {LANG_OPTIONS.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              デフォルト: <span className="text-emerald-300">{defaultLanguage || "auto"}</span>（auto は -l 省略）
            </p>
          </label>
          <label className="block text-sm md:col-span-2">
            <span className="text-slate-300">Audio file</span>
            <input
              type="file"
              accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.opus"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="mt-1 w-full rounded-lg border border-dashed border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
            />
            {file && <p className="mt-1 text-xs text-slate-400">選択: {file.name}</p>}
          </label>
          <div className="md:col-span-2 flex items-center gap-3">
            <button
              type="submit"
              disabled={creatingJob || showModelLoading || !selectedModel || !file}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700"
            >
              {creatingJob ? "作成中..." : "Start"}
            </button>
            {showModelLoading && <span className="text-xs text-slate-500">モデルを読み込み中...</span>}
          </div>
        </form>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold text-white">Jobs</h2>
            <div className="flex items-center gap-2 text-xs">
              {[
                { key: "ALL", label: "All" },
                { key: "ACTIVE", label: "Active" },
                { key: "DONE", label: "Done" },
                { key: "FAILED", label: "Failed" },
                { key: "CANCELLED", label: "Cancelled" }
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setJobsFilter(item.key as typeof jobsFilter)}
                  className={`rounded-full border px-2 py-1 ${jobsFilter === item.key ? "border-emerald-400/70 bg-emerald-500/20 text-emerald-100" : "border-slate-700 text-slate-200 hover:border-emerald-400/50"}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {jobsPhase === "fetching" && <span className="text-xs text-slate-400">更新中...</span>}
            <button
              type="button"
              onClick={() => pollJobs()}
              className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:border-emerald-400 hover:text-emerald-100"
            >
              Refresh
            </button>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                className="accent-emerald-400"
                checked={showJobsDebug}
                onChange={(e) => setShowJobsDebug(e.target.checked)}
              />
              Jobs Debug
            </label>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          {filteredJobs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-700 bg-slate-950/60 p-4 text-sm text-slate-400">
              {showJobsLoading ? "ジョブを読み込み中..." : "まだジョブがありません。音声をアップロードして開始してください。"}
            </p>
          ) : (
            filteredJobs.map((job) => {
              const expanded = expandedJobs.has(job.id);
              const detail = jobDetails[job.id] ?? jobs.find((j) => j.id === job.id);
              return (
                <article
                  key={job.id}
                  className="rounded-lg border border-slate-800 bg-slate-950/40 p-4 shadow-sm"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={job.status} />
                        <span className="text-sm font-semibold text-white">{job.inputOriginalName}</span>
                      </div>
                      <div className="text-xs text-slate-400">
                        Model: <span className="text-slate-200">{job.modelFile}</span> / Lang:{" "}
                        <span className="text-slate-200">{job.language}</span>
                      </div>
                      <div className="text-xs text-slate-500">
                        Created: {formatDate(job.createdAt)}{" "}
                        {job.finishedAt ? `| Finished: ${formatDate(job.finishedAt)}` : ""}
                      </div>
                      {job.errorMessage && (
                        <div className="text-xs text-red-300">Error: {job.errorMessage}</div>
                      )}
                      {job.warnings?.length ? (
                        <div className="text-[11px] text-amber-200">{job.warnings.join(" ")}</div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {job.status === "running" && (
                        <button
                          type="button"
                          onClick={() => handleCancelJob(job.id)}
                          className="rounded-md border border-amber-400 px-3 py-1 text-xs text-amber-100 hover:bg-amber-500/20"
                        >
                          Cancel
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => toggleJobDetails(job.id)}
                        className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:border-emerald-400 hover:text-emerald-100"
                      >
                        {expanded ? "Hide" : "Details"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteJob(job)}
                        className="rounded-md border border-red-400 px-3 py-1 text-xs text-red-100 hover:bg-red-500/20"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {expanded && (
                    <div className="mt-3 space-y-2 rounded-md border border-slate-800 bg-slate-950/70 p-3">
                      {detail ? (
                        <div className="space-y-3 text-sm text-slate-200">
                          <div className="grid gap-2 md:grid-cols-2">
                            <InfoRow label="Status">{detail.status}</InfoRow>
                            <InfoRow label="Model">{detail.modelFile}</InfoRow>
                            <InfoRow label="Language">{detail.language}</InfoRow>
                            <InfoRow label="Input">{detail.inputOriginalName}</InfoRow>
                            <InfoRow label="Created">{formatDate(detail.createdAt)}</InfoRow>
                            <InfoRow label="Finished">{formatDate(detail.finishedAt)}</InfoRow>
                          </div>
                          <InfoRow label="Download">
                            {detail.downloadUrl ? (
                              <a
                                href={detail.downloadUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-emerald-300 underline decoration-dotted"
                              >
                                Download
                              </a>
                            ) : (
                              "-"
                            )}
                          </InfoRow>
                          {detail.stdoutTail ? (
                            <InfoRow label="stdout preview">
                              <pre className="block whitespace-pre-wrap break-words text-xs text-emerald-200 bg-slate-900/60 rounded-md p-2">
{detail.stdoutTail}
                              </pre>
                            </InfoRow>
                          ) : (
                            <InfoRow label="stdout preview">No preview available.</InfoRow>
                          )}
                          {detail.errorMessage && (
                            <div className="rounded-md border border-red-400/50 bg-red-900/30 px-3 py-2 text-xs text-red-100">
                              {detail.errorMessage}
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-xs text-slate-400">Job not found in list.</p>
                      )}
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>
      </section>

      {showModelsDebug && (
        <section className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-xs text-slate-200">
          <h3 className="text-sm font-semibold text-white">Models Fetch Debug</h3>
          <div className="mt-2 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            <DebugRow label="modelsFetchAttempt">{modelsFetchAttempt}</DebugRow>
            <DebugRow label="modelsPhase">{modelsPhase}</DebugRow>
            <DebugRow label="modelsLastRequestUrl">{modelsLastRequestUrl ?? "N/A"}</DebugRow>
            <DebugRow label="modelsLastHttpStatus">{modelsLastHttpStatus ?? "N/A"}</DebugRow>
            <DebugRow label="modelsLastFetchError">{modelsLastFetchError ?? "N/A"}</DebugRow>
            <DebugRow label="modelsLastUpdatedAt">
              {modelsLastUpdatedAt ? new Date(modelsLastUpdatedAt).toLocaleString() : "N/A"}
            </DebugRow>
            <DebugRow label="modelsLastRawText">{modelsLastRawText ?? "N/A"}</DebugRow>
            <DebugRow label="modelsExtractedCount">{modelsExtractedCount ?? "N/A"}</DebugRow>
            <DebugRow label="modelsStateLength">{models.length}</DebugRow>
            <DebugRow label="selectedModel">{selectedModel || "N/A"}</DebugRow>
            <DebugRow label="isModelsReady">{isModelsReady ? "true" : "false"}</DebugRow>
            <DebugRow label="isModelsLoading">{loadingModels ? "true" : "false"}</DebugRow>
            <DebugRow label="showModelLoading">{showModelLoading ? "true" : "false"}</DebugRow>
          </div>
          <div className="mt-2 space-y-2">
            <div>
              <div className="text-slate-400">modelsLastPayload (raw)</div>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-slate-900 p-2 text-[11px] leading-snug text-emerald-100">
{modelsLastPayload ? JSON.stringify(modelsLastPayload, null, 2) : "N/A"}
              </pre>
            </div>
          </div>
        </section>
      )}

      {showJobsDebug && (
        <section className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-xs text-slate-200">
          <h3 className="text-sm font-semibold text-white">Jobs Fetch Debug</h3>
          <div className="mt-2 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            <DebugRow label="jobsFetchAttempt">{jobsFetchAttempt}</DebugRow>
            <DebugRow label="jobsPhase">{jobsPhase}</DebugRow>
            <DebugRow label="jobsLastHttpStatus">{jobsLastHttpStatus ?? "N/A"}</DebugRow>
            <DebugRow label="jobsLastUpdatedAt">
              {jobsLastUpdatedAt ? new Date(jobsLastUpdatedAt).toLocaleString() : "N/A"}
            </DebugRow>
            <DebugRow label="jobsStateLength">{jobs.length}</DebugRow>
            <DebugRow label="filteredJobsLength">{filteredJobs.length}</DebugRow>
            <DebugRow label="isJobsLoading">{jobsPhase === "fetching" ? "true" : "false"}</DebugRow>
            <DebugRow label="showJobsLoading">{showJobsLoading ? "true" : "false"}</DebugRow>
            <DebugRow label="jobsLastFetchError">{jobsLastFetchError ?? "N/A"}</DebugRow>
            <DebugRow label="jobsLastRawText">{jobsLastRawText ?? "N/A"}</DebugRow>
            <DebugRow label="openJobId">{openJobId ?? "N/A"}</DebugRow>
          </div>
          <div className="mt-2 space-y-2">
            <div>
              <div className="text-slate-400">jobsLastPayload (raw)</div>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-slate-900 p-2 text-[11px] leading-snug text-emerald-100">
{jobsLastPayload ? JSON.stringify(jobsLastPayload, null, 2) : "N/A"}
              </pre>
            </div>
            <div>
              <div className="text-slate-400">jobsLastRawText</div>
              <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-slate-900 p-2 text-[11px] leading-snug text-emerald-100">
{jobsLastRawText ?? "N/A"}
              </pre>
            </div>
            <div>
              <div className="text-slate-400">openJob stderrTail (first 2000 chars)</div>
              <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-slate-900 p-2 text-[11px] leading-snug text-amber-100">
{openJob?.stderrTail ? openJob.stderrTail.slice(0, 2000) : "N/A"}
              </pre>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function isAbortError(err: unknown) {
  return err instanceof DOMException && err.name === "AbortError";
}

function extractError(err: unknown) {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "予期しないエラーが発生しました。";
}

function copyText(text: string) {
  if (!navigator?.clipboard) return;
  navigator.clipboard.writeText(text).catch(() => undefined);
}

function abortTracker(ref: MutableRefObject<RequestTracker>) {
  if (ref.current.controller) {
    ref.current.controller.abort();
    ref.current.controller = null;
  }
}

function abortIfSame(ref: MutableRefObject<RequestTracker>, controller: AbortController) {
  if (ref.current.controller === controller) {
    ref.current.controller = null;
  }
}

function buildAbort(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeout };
}

function StatusBadge({ status }: { status: WhisperJobSummary["status"] }) {
  const map: Record<WhisperJobSummary["status"], string> = {
    queued: "border-slate-500 bg-slate-700/40 text-slate-100",
    running: "border-amber-400 bg-amber-500/20 text-amber-100",
    succeeded: "border-emerald-400 bg-emerald-500/20 text-emerald-100",
    failed: "border-red-400 bg-red-500/20 text-red-100",
    cancelled: "border-slate-500 bg-slate-600/30 text-slate-200"
  };
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${map[status]}`}>{status}</span>;
}

function Banner({ tone, message }: { tone: "error" | "info"; message: string }) {
  const styles =
    tone === "error"
      ? "border-red-500/40 bg-red-900/40 text-red-100"
      : "border-emerald-500/40 bg-emerald-900/40 text-emerald-100";
  return <div className={`rounded-lg border px-4 py-3 text-sm ${styles}`}>{message}</div>;
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
      <span className="text-xs uppercase tracking-[0.1em] text-slate-500">{label}</span>
      <span className="text-sm text-slate-100">{children}</span>
    </div>
  );
}

function DebugRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-slate-800 bg-slate-900/70 px-3 py-2">
      <span className="text-[11px] uppercase tracking-[0.1em] text-slate-500">{label}</span>
      <span className="text-[12px] text-slate-100 break-words">{children}</span>
    </div>
  );
}
