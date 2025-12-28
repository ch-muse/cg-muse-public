import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiClientError, API_BASE_URL } from "../lib/api.js";
import type { ComfyStatus } from "../types.js";

const POLL_MS = 3000;
const FETCH_TIMEOUT_MS = 2000;

type ComfyStatusPayload = { status: ComfyStatus };

export default function ComfyPanel() {
  const [status, setStatus] = useState<ComfyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [debug, setDebug] = useState(false);
  const [lastPayload, setLastPayload] = useState<ComfyStatusPayload | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [fetchAttempt, setFetchAttempt] = useState(0);
  const [lastRequestUrl, setLastRequestUrl] = useState<string | null>(null);
  const [lastHttpStatus, setLastHttpStatus] = useState<number | null>(null);
  const [lastFetchError, setLastFetchError] = useState<string | null>(null);
  const [lastStatusExtracted, setLastStatusExtracted] = useState<ComfyStatus | null>(null);
  const [lastRawText, setLastRawText] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [requestIdState, setRequestIdState] = useState<number | null>(null);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const mounted = useRef(true);
  const requestIdRef = useRef(0);
  const inFlightRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  const applyStatus = useCallback((payload: ComfyStatusPayload) => {
    setStatus(payload.status);
    setLastStatusExtracted(payload.status);
  }, []);

  const fetchStatus = useCallback(
    async (opts?: { silent?: boolean }) => {
      const url = `${API_BASE_URL}/api/comfy/status?t=${Date.now()}`;
      const currentId = requestIdRef.current + 1;
      requestIdRef.current = currentId;
      setRequestIdState(currentId);
      setPhase("start");
      setFetchAttempt((prev) => prev + 1);
      setLastRequestUrl(url);
      setLastFetchError(null);
      setLastRawText(null);
      setLastHttpStatus(null);
      setElapsedMs(null);
      const started = performance.now();
      setStartedAtMs(started);

      if (inFlightRef.current) {
        inFlightRef.current.abort();
      }
      const controller = new AbortController();
      inFlightRef.current = controller;

      if (!opts?.silent) setLoading(true);
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        setPhase("fetching");
        const res = await fetch(url, { cache: "no-store", signal: controller.signal });
        setPhase("got-response");
        setLastHttpStatus(res.status);

        setPhase("read-text");
        const text = await res.text();
        setLastRawText(text ? text.slice(0, 1000) : "");

        let json: unknown = null;
        if (text) {
          try {
            json = JSON.parse(text);
            setPhase("parsed-json");
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setLastFetchError(`JSON parse failed: ${msg}`);
            setPhase("error");
            return;
          }
        } else {
          setPhase("parsed-json");
        }

        setLastPayload(json as ComfyStatusPayload);

        const extracted = (json as any)?.data?.status ?? null;
        setLastStatusExtracted(extracted);

        if (!extracted) {
          setLastFetchError("payload shape mismatch: expected data.status");
          setPhase("error");
          return;
        }

        if (currentId !== requestIdRef.current) return;

        applyStatus({ status: extracted as ComfyStatus });
        setError(null);
        setPhase("done");
      } catch (err: unknown) {
        if (!mounted.current) return;
        const msg =
          err instanceof DOMException && err.name === "AbortError"
            ? "timeout/abort"
            : err instanceof Error
              ? err.message
              : String(err);
        setLastFetchError(msg);
        setError(extractError(err));
        setPhase("error");
      } finally {
        clearTimeout(timeout);
        if (inFlightRef.current === controller) {
          inFlightRef.current = null;
        }
        if (mounted.current) {
          setLastUpdatedAt(new Date().toISOString());
          setElapsedMs(performance.now() - started);
          if (!opts?.silent) setLoading(false);
        }
      }
    },
    [applyStatus]
  );

  useEffect(() => {
    const interval = setInterval(() => {
      fetchStatus({ silent: true });
    }, POLL_MS);
    fetchStatus();
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleStart = async () => {
    setStarting(true);
    setActionMessage(null);
    setError(null);
    try {
      const result = await api.startComfy();
      if (!mounted.current) return;
      if (result.status) {
        applyStatus({ status: result.status });
        setLastStatusExtracted(result.status);
        setLastPayload({ status: result.status });
      }
      setActionMessage(result.message || (result.started ? "ComfyUI started" : "ComfyUI is already running"));
      await fetchStatus({ silent: true });
    } catch (err: unknown) {
      if (!mounted.current) return;
      setError(extractError(err));
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    setActionMessage(null);
    setError(null);
    try {
      const result = await api.stopComfy();
      if (!mounted.current) return;
      if (result.status) {
        applyStatus({ status: result.status });
        setLastStatusExtracted(result.status);
        setLastPayload({ status: result.status });
      }
      setActionMessage(result.message || (result.stopped ? "ComfyUI stopped" : "Stop is allowed only for API-managed process"));
      await fetchStatus({ silent: true });
    } catch (err: unknown) {
      if (!mounted.current) return;
      setError(extractError(err));
    } finally {
      if (mounted.current) setStopping(false);
    }
  };

  const running = status?.running ?? false;
  const managed = status?.managed ?? false;
  const disableStart = running || starting;
  const disableStop = !running || !managed || stopping;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm uppercase tracking-[0.25em] text-slate-400">Internals</p>
          <h1 className="text-3xl font-semibold">ComfyUI</h1>
          <p className="text-sm text-slate-400">ローカル ComfyUI の状態確認と Start/Stop を行います。</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              className="accent-emerald-400"
              checked={debug}
              onChange={(e) => setDebug(e.target.checked)}
            />
            Debug
          </label>
          <button
            type="button"
            onClick={() => fetchStatus()}
            className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:border-emerald-400 hover:text-emerald-100"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-900/30 px-4 py-3 text-sm text-red-100">
          {error}
        </div>
      )}

      {actionMessage && !error && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-900/30 px-4 py-3 text-sm text-emerald-100">
          {actionMessage}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70 shadow-lg">
        <div className="flex flex-col gap-6 p-6 md:flex-row md:items-start md:justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <StatusBadge running={running} />
              <span className="text-lg font-semibold text-white">{running ? "Running" : "Stopped"}</span>
              <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-300">
                {managed ? "managed by API" : "external / unmanaged"}
              </span>
            </div>
            <div className="space-y-1 text-sm text-slate-300">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400">URL:</span>
                {status ? (
                  <a
                    href={status.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-300 hover:text-emerald-200 underline decoration-dotted"
                  >
                    {status.url}
                  </a>
                ) : (
                  <span className="text-slate-500">--</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400">PID:</span>
                <span className="text-slate-200">{status?.pid ?? "-"}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400">Last start:</span>
                <span className="text-slate-200">{formatDate(status?.timestamps.lastStartAt)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400">Last probe:</span>
                <span className="text-slate-200">{formatDate(status?.timestamps.lastProbeAt)}</span>
              </div>
            </div>
            {status?.lastError && (
              <div className="rounded-md border border-amber-400/40 bg-amber-900/30 px-3 py-2 text-xs text-amber-100">
                {status.lastError}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <button
              type="button"
              disabled={disableStart}
              onClick={handleStart}
              className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 shadow-md transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-emerald-800 disabled:text-emerald-200"
            >
              {starting ? "Starting..." : "Start"}
            </button>
            <button
              type="button"
              disabled={disableStop}
              onClick={handleStop}
              className="rounded-md border border-red-400 px-4 py-2 text-sm font-semibold text-red-100 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-400"
            >
              {stopping ? "Stopping..." : "Stop (API managed only)"}
            </button>
            <p className="text-xs text-slate-400">ポーリング間隔: {Math.round(POLL_MS / 100) / 10}s</p>
          </div>
        </div>

        <div className="border-t border-slate-800 bg-slate-950/60 px-6 py-4 text-sm text-slate-200">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <InfoRow label="Listen">{status?.config.listen ?? "-"}</InfoRow>
            <InfoRow label="Port">{status?.config.port ?? "-"}</InfoRow>
            <InfoRow label="Dir">{status ? truncateMiddle(status.config.dir, 60) : "-"}</InfoRow>
            <InfoRow label="Python">{status ? truncateMiddle(status.config.python, 60) : "-"}</InfoRow>
            <InfoRow label="Extra args">{status?.config.extraArgsPresent ? "Yes" : "No"}</InfoRow>
          </div>
        </div>
      </div>

      {loading && (
        <div className="text-sm text-slate-400">
          状態を取得しています...
        </div>
      )}

      {debug && (
        <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-4 text-xs text-slate-200">
          <div className="mb-2 font-semibold text-slate-300">Debug</div>
          <div className="mb-2 grid gap-2 md:grid-cols-2">
            <div>Fetch attempt: {fetchAttempt}</div>
            <div>Last request: {lastRequestUrl ?? "N/A"}</div>
            <div>Last HTTP status: {lastHttpStatus ?? "N/A"}</div>
            <div>Last fetch error: {lastFetchError ?? "N/A"}</div>
            <div>Phase: {phase ?? "N/A"}</div>
            <div>Request id: {requestIdState ?? "N/A"}</div>
            <div>Started at: {startedAtMs ? `${startedAtMs.toFixed(0)} ms` : "N/A"}</div>
            <div>Elapsed: {elapsedMs !== null ? `${elapsedMs.toFixed(0)} ms` : "N/A"}</div>
            <div>Last updated: {lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleString() : "N/A"}</div>
            <div>Phase: {phase ?? "N/A"}</div>
            <div>Last raw text: {lastRawText ?? "N/A"}</div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <div className="mb-1 text-slate-400">Last payload (raw)</div>
              <pre className="max-h-64 overflow-auto rounded-md bg-slate-900 p-2 text-[11px] leading-snug text-emerald-100">
{JSON.stringify(lastPayload, null, 2) || "N/A"}
              </pre>
            </div>
            <div>
              <div className="mb-1 text-slate-400">UI state (status)</div>
              <pre className="max-h-64 overflow-auto rounded-md bg-slate-900 p-2 text-[11px] leading-snug text-emerald-100">
{JSON.stringify(status, null, 2) || "N/A"}
              </pre>
            </div>
            <div>
              <div className="mb-1 text-slate-400">Last status extracted (data.status)</div>
              <pre className="max-h-64 overflow-auto rounded-md bg-slate-900 p-2 text-[11px] leading-snug text-emerald-100">
{JSON.stringify(lastStatusExtracted, null, 2) || "N/A"}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ running }: { running: boolean }) {
  const color = running ? "bg-emerald-400 shadow-emerald-400/50" : "bg-slate-500 shadow-slate-500/30";
  const label = running ? "Running" : "Stopped";
  return <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold text-slate-950 shadow ${color}`}>{label}</span>;
}

function truncateMiddle(value: string, max = 60) {
  if (!value) return "-";
  if (value.length <= max) return value;
  const head = Math.floor(max / 2);
  const tail = max - head - 3;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2">
      <span className="text-xs uppercase tracking-[0.1em] text-slate-500">{label}</span>
      <span className="text-sm text-slate-100">{children}</span>
    </div>
  );
}

function extractError(err: unknown) {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Failed to load ComfyUI status.";
}
