import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError } from "../lib/api.js";
import type { Idea, LlmModel, Session, SessionEvent, SessionSummary } from "../types.js";

const SESSION_STORAGE_KEY = "cg-muse.activeSessionId";
const countOptions = Array.from({ length: 10 }, (_, idx) => idx + 1);

type ActivityStatus = "RUNNING" | "DONE" | "ERROR" | "CANCELLED";

interface ActivityItem {
  requestId: string;
  startedAt: string;
  finishedAt?: string;
  theme?: string;
  count?: number;
  model?: string;
  status: ActivityStatus;
}

const formatDate = (value?: string | null) => {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value ?? "";
  }
};

const shortId = (value?: string | null) => (value ? value.slice(0, 8) : "");

export default function PlayMusePage() {
  const [models, setModels] = useState<LlmModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [sessionTitle, setSessionTitle] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [theme, setTheme] = useState("");
  const [count, setCount] = useState(3);
  const [creatingSession, setCreatingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [likingIdeaIds, setLikingIdeaIds] = useState<Set<string>>(new Set());
  const [generateController, setGenerateController] = useState<AbortController | null>(null);

  const generatingIdeas = Boolean(generateController);

  const activityItems = useMemo(() => buildActivity(events), [events]);
  const runningItem = activityItems.find((item) => item.status === "RUNNING");
  const historyItems = activityItems.filter((item) => item.requestId !== runningItem?.requestId).slice(0, 10);

  const activeModelName = useMemo(() => selectedModel || models[0]?.name || "", [models, selectedModel]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    if (typeof window === "undefined") return;
    if (activeSessionId) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, activeSessionId);
    } else {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, [activeSessionId]);

  useEffect(() => {
    let cancelled = false;
    const loadModels = async () => {
      try {
        setModelsLoading(true);
        const data = await api.getModels();
        if (cancelled) return;
        setModels(data.models ?? []);
      } catch (err) {
        if (!cancelled) setError(extractErrorMessage(err));
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    };
    loadModels();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedModel && models.length > 0) {
      setSelectedModel(models[0]?.name || "");
    }
  }, [models, selectedModel]);

  const refreshSessionDetails = useCallback(
    async (sessionId: string, options?: { updateIdeas?: boolean; updateSession?: boolean }) => {
      const data = await api.fetchSession(sessionId);
      if (activeSessionIdRef.current !== sessionId) {
        return data;
      }
      if (options?.updateSession !== false) {
        setSession(data.session);
      }
      if (options?.updateIdeas !== false) {
        setIdeas(data.ideas);
      }
      setEvents(data.events);
      return data;
    },
    []
  );

  const loadSessions = useCallback(
    async (preferredId?: string | null) => {
      try {
        setSessionsLoading(true);
        const data = await api.fetchSessions();
        setSessions(data.sessions);
        const stored = typeof window !== "undefined" ? window.localStorage.getItem(SESSION_STORAGE_KEY) : null;
        setActiveSessionId((current) => {
          const ids = new Set(data.sessions.map((item) => item.id));
          if (current && ids.has(current)) return current;
          if (preferredId && ids.has(preferredId)) return preferredId;
          if (stored && ids.has(stored)) return stored;
          return data.sessions[0]?.id ?? null;
        });
      } catch (err) {
        setError(extractErrorMessage(err));
      } finally {
        setSessionsLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(SESSION_STORAGE_KEY) : null;
    loadSessions(stored);
  }, [loadSessions]);

  useEffect(() => {
    if (!activeSessionId) {
      setSession(null);
      setIdeas([]);
      setEvents([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        setSessionLoading(true);
        await refreshSessionDetails(activeSessionId);
      } catch (err) {
        if (!cancelled) setError(extractErrorMessage(err));
      } finally {
        if (!cancelled) setSessionLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, refreshSessionDetails]);

  const handleCreateSession = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeModelName) {
      setError("利用可能なモデルが見つかりません。");
      return;
    }
    try {
      setCreatingSession(true);
      setError(null);
      const payload: { title?: string; llmModel: string } = {
        llmModel: activeModelName
      };
      const trimmedTitle = sessionTitle.trim();
      if (trimmedTitle) payload.title = trimmedTitle;
      const data = await api.createSession(payload);
      setSession(data.session);
      setIdeas([]);
      setEvents([]);
      setSessionTitle("");
      setActiveSessionId(data.session.id);
      await loadSessions(data.session.id);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setCreatingSession(false);
    }
  };

  const handleGenerateIdeas = async (event: FormEvent) => {
    event.preventDefault();
    if (!session) {
      setError("先にセッションを作成してください。");
      return;
    }
    if (generatingIdeas) return;
    const controller = new AbortController();
    setGenerateController(controller);
    setError(null);
    const payload = {
      sessionId: session.id,
      count,
      ...(theme.trim() ? { theme: theme.trim() } : {})
    };
    refreshSessionDetails(session.id, { updateIdeas: false, updateSession: false }).catch(() => undefined);
    try {
      const data = await api.generateIdeas(payload, { signal: controller.signal });
      setIdeas((prev) => [...data.ideas, ...prev]);
    } catch (err) {
      if (!isAbortError(err)) {
        setError(extractErrorMessage(err));
      }
    } finally {
      setGenerateController((current) => (current === controller ? null : current));
      if (session?.id) {
        try {
          await refreshSessionDetails(session.id);
        } catch (err) {
          if (!isAbortError(err)) {
            setError(extractErrorMessage(err));
          }
        }
      }
    }
  };

  const handleCancelGenerate = () => {
    if (!generateController) return;
    generateController.abort();
  };

  const toggleIdeaLike = async (idea: Idea) => {
    setError(null);
    setLikingIdeaIds((prev) => {
      const next = new Set(prev);
      next.add(idea.id);
      return next;
    });
    try {
      const data = await api.toggleIdeaLike(idea.id, !idea.liked);
      setIdeas((prev) => prev.map((item) => (item.id === idea.id ? data.idea : item)));
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLikingIdeaIds((prev) => {
        const next = new Set(prev);
        next.delete(idea.id);
        return next;
      });
    }
  };

  const handleDeleteIdea = async (idea: Idea) => {
    if (!window.confirm("このアイデアを削除しますか？")) return;
    try {
      await api.deleteIdea(idea.id);
      setIdeas((prev) => prev.filter((item) => item.id !== idea.id));
      if (session?.id) {
        refreshSessionDetails(session.id, { updateSession: false, updateIdeas: false }).catch(() => undefined);
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const handleClearHistory = async () => {
    if (!session) return;
    if (!window.confirm("このセッションの履歴を削除しますか？")) return;
    try {
      await api.clearSessionEvents(session.id);
      setEvents([]);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const handleDeleteSession = async () => {
    if (!session) return;
    if (!window.confirm("このセッションを削除しますか？関連するアイデアとイベントも削除されます。")) return;
    try {
      await api.deleteSession(session.id);
      setSession(null);
      setIdeas([]);
      setEvents([]);
      setActiveSessionId(null);
      await loadSessions(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  const promptToCreateSession = !session && !sessionLoading;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-400 uppercase tracking-[0.2em]">Play</p>
          <h1 className="text-3xl font-semibold">Muse</h1>
          <p className="text-sm text-slate-400">セッションを選択/作成し、テーマからアイデアを生成します。</p>
        </div>
        {session && (
          <Link
            className="rounded-full border border-emerald-400/40 bg-emerald-500/20 px-3 py-1 text-sm text-emerald-100"
            to={`/internals/sessions/${session.id}`}
          >
            Internalsへ
          </Link>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-900/30 px-4 py-3 text-sm text-red-100">
          {error}
        </div>
      )}

      <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Active Session</p>
            {session ? (
              <>
                <h2 className="text-2xl font-semibold text-white">
                  {session.title?.trim() ? session.title : `Session ${shortId(session.id)}`}
                </h2>
                <p className="text-sm text-slate-400">Model: {session.llm_model}</p>
              </>
            ) : sessionLoading ? (
              <p className="text-sm text-slate-400">読み込み中...</p>
            ) : (
              <p className="text-sm text-slate-400">アクティブなセッションがありません。</p>
            )}
          </div>
          <div className="flex flex-col gap-2 text-sm md:flex-row md:items-center">
            <label className="flex flex-col text-slate-300">
              <span className="text-xs uppercase tracking-wide text-slate-500">切替</span>
              <select
                value={activeSessionId ?? ""}
                onChange={(event) => setActiveSessionId(event.target.value || null)}
                disabled={sessionsLoading || sessions.length === 0}
                className="mt-1 w-60 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none disabled:opacity-50"
              >
                <option value="">未選択</option>
                {sessions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title?.trim() ? item.title : `Session ${shortId(item.id)}`}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => loadSessions(activeSessionId)}
              className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-200 hover:border-emerald-400 hover:text-emerald-100"
            >
              セッション再取得
            </button>
            {session && (
              <>
                <button
                  type="button"
                  onClick={handleClearHistory}
                  className="rounded-lg border border-amber-500/50 px-3 py-2 text-xs text-amber-100 hover:bg-amber-500/10"
                >
                  Clear history
                </button>
                <button
                  type="button"
                  onClick={handleDeleteSession}
                  className="rounded-lg border border-red-500/60 px-3 py-2 text-xs text-red-100 hover:bg-red-500/10"
                >
                  Delete session
                </button>
              </>
            )}
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg lg:col-span-2">
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-semibold">新規セッション作成</h2>
                  <p className="text-sm text-slate-400">タイトルは任意、モデルは Ollama から取得します。</p>
                </div>
                {modelsLoading && <span className="text-xs text-slate-500">モデル読み込み中...</span>}
              </div>
              <form className="mt-6 space-y-4" onSubmit={handleCreateSession}>
                <label className="block text-sm">
                  <span className="text-slate-300">タイトル（任意）</span>
                  <input
                    type="text"
                    value={sessionTitle}
                    onChange={(event) => setSessionTitle(event.target.value)}
                    placeholder="例: 週末のVJ用ネタ集"
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-slate-300">モデル</span>
                  <select
                    value={activeModelName}
                    onChange={(event) => setSelectedModel(event.target.value)}
                    disabled={modelsLoading || models.length === 0 || creatingSession}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none disabled:opacity-50"
                  >
                    {models.length === 0 && <option value="">モデルなし</option>}
                    {models.map((model) => (
                      <option key={model.name} value={model.name}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  disabled={creatingSession || !activeModelName}
                  className="w-full rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-600"
                >
                  {creatingSession ? "作成中..." : "新規セッション作成"}
                </button>
              </form>
              <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/80 p-4 text-sm text-slate-300">
                {sessionLoading && <p>アクティブセッションを読み込み中...</p>}
                {promptToCreateSession && <p>まだセッションがありません。上のフォームから作成してください。</p>}
                {session && (
                  <div>
                    <p className="font-semibold text-slate-100">{session.title || "Untitled Session"}</p>
                    <p className="text-xs text-slate-400">
                      モデル: <span className="text-slate-100">{session.llm_model}</span>
                    </p>
                    <p className="text-xs text-slate-500 mt-1">作成日時: {formatDate(session.created_at)}</p>
                    <Link
                      className="mt-2 inline-flex text-xs text-emerald-300 underline decoration-dotted"
                      to={`/internals/sessions/${session.id}`}
                    >
                      Internalsでこのセッションを見る
                    </Link>
                  </div>
                )}
              </div>
            </div>

            <div>
              <h2 className="text-xl font-semibold">アイデア生成</h2>
              <p className="text-sm text-slate-400">テーマと生成数を入力してアイデアを取得します。</p>
              <form className="mt-6 space-y-4" onSubmit={handleGenerateIdeas}>
                <label className="block text-sm">
                  <span className="text-slate-300">テーマ（任意）</span>
                  <input
                    type="text"
                    value={theme}
                    onChange={(event) => setTheme(event.target.value)}
                    placeholder="夜景 / サイバーパンク / 海"
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-slate-300">生成件数（1〜10）</span>
                  <select
                    value={count}
                    onChange={(event) => setCount(Number(event.target.value))}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  >
                    {countOptions.map((value) => (
                      <option value={value} key={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex gap-3">
                  <button
                    type="submit"
                    disabled={!session || generatingIdeas}
                    className="flex-1 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-600"
                  >
                    {generatingIdeas ? "生成中..." : "生成"}
                  </button>
                  {generatingIdeas && (
                    <button
                      type="button"
                      onClick={handleCancelGenerate}
                      className="rounded-lg border border-red-400 px-4 py-2 text-sm font-semibold text-red-200 hover:bg-red-500/20"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </form>
              {!session && !sessionLoading && (
                <p className="mt-4 text-sm text-red-200">先にセッションを作成すると生成できます。</p>
              )}
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg">
          <h2 className="text-xl font-semibold text-white">Activity</h2>
          <div className="mt-4 space-y-4 text-sm text-slate-300">
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
              <p className="text-xs uppercase text-slate-400">Now Running</p>
              {runningItem ? (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center justify-between text-white">
                    <span className="font-semibold">{runningItem.theme || "Freestyle"}</span>
                    <StatusBadge status="RUNNING" />
                  </div>
                  <p className="text-xs text-slate-400">Count: {runningItem.count ?? "-"}</p>
                  <p className="text-xs text-slate-400">Model: {runningItem.model ?? session?.llm_model ?? "-"}</p>
                  <p className="text-xs text-slate-500">Started: {formatDate(runningItem.startedAt)}</p>
                  <p className="text-xs text-emerald-200">Request ID: {runningItem.requestId}</p>
                </div>
              ) : (
                <p className="mt-2 text-xs text-slate-500">現在進行中の生成はありません。</p>
              )}
            </div>
            <div>
              <p className="text-xs uppercase text-slate-400">History</p>
              <div className="mt-2 space-y-2">
                {historyItems.length === 0 ? (
                  <p className="text-xs text-slate-500">最近の履歴はありません。</p>
                ) : (
                  historyItems.map((item) => (
                    <div key={item.requestId} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-semibold text-white">{item.theme || "Freestyle"}</span>
                        <StatusBadge status={item.status} />
                      </div>
                      <p className="text-xs text-slate-400">Count: {item.count ?? "-"}</p>
                      <p className="text-xs text-slate-400">Model: {item.model ?? session?.llm_model ?? "-"}</p>
                      <p className="text-xs text-slate-500">Start: {formatDate(item.startedAt)}</p>
                      {item.finishedAt && (
                        <p className="text-xs text-slate-500">End: {formatDate(item.finishedAt)}</p>
                      )}
                      <p className="text-xs text-emerald-200">Request ID: {item.requestId}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-white">Ideas</h2>
            <p className="text-sm text-slate-400">生成されたアイデアをカードで一覧表示</p>
          </div>
          {session && (
            <Link
              className="text-sm font-medium text-emerald-300 underline decoration-dotted"
              to={`/internals/sessions/${session.id}`}
            >
              Internalsでこのセッションを見る
            </Link>
          )}
        </div>
        <div className="mt-6">
          {ideas.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-700 bg-slate-900/60 p-6 text-center text-sm text-slate-400">
              {session ? "生成したアイデアがまだありません。テーマを入力して生成してみましょう。" : "セッションを作成してアイデアを生成すると表示されます。"}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {ideas.map((idea) => {
                const liking = likingIdeaIds.has(idea.id);
                return (
                  <article key={idea.id} className="rounded-lg border border-slate-800 bg-slate-900/80 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold text-white">{idea.title}</h3>
                        <p className="text-xs text-slate-500">{formatDate(idea.created_at)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleIdeaLike(idea)}
                        disabled={liking}
                        className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                          idea.liked
                            ? "border-emerald-400 bg-emerald-500/20 text-emerald-100"
                            : "border-slate-600 bg-slate-800 text-slate-200"
                        } ${liking ? "opacity-60" : "hover:border-emerald-400 hover:text-emerald-100"}`}
                      >
                        {liking ? "更新中..." : idea.liked ? "Liked" : "Like"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteIdea(idea)}
                        className="rounded-full border border-red-400 px-3 py-1 text-xs font-semibold text-red-100 transition hover:bg-red-500/20"
                      >
                        Delete
                      </button>
                    </div>
                    <p className="mt-3 text-sm text-slate-300">{idea.description}</p>
                    {idea.prompt_snippet && (
                      <p className="mt-3 text-xs font-mono text-emerald-200">Prompt: {idea.prompt_snippet}</p>
                    )}
                    {idea.tags?.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
                        {idea.tags.map((tag) => (
                          <span key={tag} className="rounded-full border border-slate-700 px-2 py-0.5 text-slate-200">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: ActivityStatus }) {
  const styles: Record<ActivityStatus, string> = {
    RUNNING: "border-amber-400/60 bg-amber-500/20 text-amber-100",
    DONE: "border-emerald-400/60 bg-emerald-500/20 text-emerald-100",
    ERROR: "border-red-400/60 bg-red-500/20 text-red-100",
    CANCELLED: "border-slate-500/60 bg-slate-600/20 text-slate-200"
  };
  const labelMap: Record<ActivityStatus, string> = {
    RUNNING: "RUNNING",
    DONE: "DONE",
    ERROR: "ERROR",
    CANCELLED: "CANCELLED"
  };
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${styles[status]}`}>{labelMap[status]}</span>;
}

function buildActivity(events: SessionEvent[]): ActivityItem[] {
  const items = new Map<string, ActivityItem>();
  for (const event of events) {
    if (!event || !event.event_type) continue;
    if (event.event_type === "LLM_REQUEST") {
      const payload = toRecord(event.payload);
      const requestId = String(payload?.request_id ?? event.id);
      const existing = items.get(requestId) ?? {
        requestId,
        startedAt: event.created_at,
        status: "RUNNING" as ActivityStatus
      };
      existing.startedAt = event.created_at;
      if (typeof payload?.theme === "string") existing.theme = payload.theme;
      if (typeof payload?.count === "number") existing.count = payload.count;
      if (typeof payload?.model === "string") existing.model = payload.model;
      items.set(requestId, existing);
      continue;
    }
    if (event.event_type === "LLM_RESPONSE" || event.event_type === "ERROR" || event.event_type === "CANCELLED") {
      const payload = toRecord(event.payload);
      const requestIdValue = payload?.request_id ?? event.id;
      if (!requestIdValue) continue;
      const requestId = String(requestIdValue);
      const existing =
        items.get(requestId) ??
        ({
          requestId,
          startedAt: event.created_at,
          status: "RUNNING"
        } as ActivityItem);
      if (event.event_type === "LLM_RESPONSE") {
        existing.status = "DONE";
      } else if (event.event_type === "CANCELLED") {
        existing.status = "CANCELLED";
      } else {
        existing.status = "ERROR";
      }
      existing.finishedAt = event.created_at;
      items.set(requestId, existing);
      continue;
    }
  }
  const list = Array.from(items.values());
  list.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return list;
}

function toRecord(value: unknown): Record<string, any> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  return null;
}

function extractErrorMessage(err: unknown) {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "予期しないエラーが発生しました。";
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
