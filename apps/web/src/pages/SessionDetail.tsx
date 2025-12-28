import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiClientError } from "../lib/api.js";
import type { Idea, Session, SessionEvent } from "../types.js";

const formatDate = (value?: string | null) => {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
};

export default function SessionDetailPage() {
  const { id } = useParams();
  const [session, setSession] = useState<Session | null>(null);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liking, setLiking] = useState<Set<string>>(new Set());
  const [deletingSession, setDeletingSession] = useState(false);

  useEffect(() => {
    if (!id) {
      setError("Session ID が不正です。");
      setLoading(false);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await api.fetchSession(id);
        if (!active) return;
        setSession(data.session);
        setIdeas(data.ideas);
        setEvents(data.events);
      } catch (err) {
        if (active) setError(extractError(err));
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [id]);

  const toggleLike = async (idea: Idea) => {
    setLiking((prev) => {
      const next = new Set(prev);
      next.add(idea.id);
      return next;
    });
    try {
      const data = await api.toggleIdeaLike(idea.id, !idea.liked);
      setIdeas((prev) => prev.map((item) => (item.id === idea.id ? data.idea : item)));
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLiking((prev) => {
        const next = new Set(prev);
        next.delete(idea.id);
        return next;
      });
    }
  };

  const deleteIdea = async (idea: Idea) => {
    if (!window.confirm("このアイデアを削除しますか？")) return;
    try {
      await api.deleteIdea(idea.id);
      setIdeas((prev) => prev.filter((item) => item.id !== idea.id));
      if (id) {
        const data = await api.fetchSession(id);
        setEvents(data.events);
      }
    } catch (err) {
      setError(extractError(err));
    }
  };

  const clearHistory = async () => {
    if (!id || !session) return;
    if (!window.confirm("このセッションの履歴を削除しますか？")) return;
    try {
      await api.clearSessionEvents(session.id);
      setEvents([]);
    } catch (err) {
      setError(extractError(err));
    }
  };

  const deleteSession = async () => {
    if (!id || !session) return;
    if (!window.confirm("このセッションを削除しますか？関連するアイデアも削除されます。")) return;
    try {
      setDeletingSession(true);
      await api.deleteSession(session.id);
      setSession(null);
      setIdeas([]);
      setEvents([]);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setDeletingSession(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-slate-400 uppercase tracking-[0.2em]">Internals</p>
          <h1 className="text-3xl font-semibold">Session Detail</h1>
          <p className="text-sm text-slate-400">Session ID: {id}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/internals/sessions"
            className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-emerald-400 hover:text-emerald-100"
          >
            一覧へ戻る
          </Link>
          {session && (
            <>
              <button
                type="button"
                onClick={clearHistory}
                className="rounded-md border border-amber-500/50 px-3 py-2 text-xs text-amber-100 hover:bg-amber-500/10"
              >
                Clear history
              </button>
              <button
                type="button"
                disabled={deletingSession}
                onClick={deleteSession}
                className="rounded-md border border-red-500/60 px-3 py-2 text-xs text-red-100 hover:bg-red-500/10 disabled:opacity-60"
              >
                Delete session
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-900/30 px-4 py-3 text-sm text-red-100">{error}</div>
      )}

      {loading ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 text-center text-sm text-slate-400">
          読み込み中...
        </div>
      ) : !session ? (
        <div className="rounded-xl border border-red-500/30 bg-red-900/30 p-6 text-center text-sm text-red-100">
          セッションが見つかりません。
        </div>
      ) : (
        <>
          <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg">
            <h2 className="text-xl font-semibold text-white">Session</h2>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase text-slate-500">Title</dt>
                <dd className="text-lg text-white">{session.title || "Untitled"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-slate-500">Model</dt>
                <dd className="text-lg text-emerald-200">{session.llm_model}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-slate-500">Mode</dt>
                <dd className="text-sm text-slate-300">{session.mode}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-slate-500">Created</dt>
                <dd className="text-sm text-slate-300">{formatDate(session.created_at)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-slate-500">Updated</dt>
                <dd className="text-sm text-slate-300">{formatDate(session.updated_at)}</dd>
              </div>
            </dl>
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">Ideas</h2>
                <p className="text-sm text-slate-400">生成されたアイデア一覧です。ここでもLikeを切り替えられます。</p>
              </div>
              <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-400">{ideas.length} 件</span>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {ideas.length === 0 && (
                <div className="col-span-full rounded-lg border border-dashed border-slate-700 bg-slate-900/60 p-6 text-center text-sm text-slate-400">
                  アイデアがまだありません。
                </div>
              )}
              {ideas.map((idea) => {
                const isLiking = liking.has(idea.id);
                return (
                  <article key={idea.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="text-lg font-semibold text-white">{idea.title}</h3>
                        <p className="text-xs text-slate-500">{formatDate(idea.created_at)}</p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => toggleLike(idea)}
                          disabled={isLiking}
                          className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                            idea.liked
                              ? "border-emerald-400 bg-emerald-500/20 text-emerald-100"
                              : "border-slate-600 bg-slate-800 text-slate-200"
                          } ${isLiking ? "opacity-60" : "hover:border-emerald-400 hover:text-emerald-100"}`}
                        >
                          {isLiking ? "更新中..." : idea.liked ? "Liked" : "Like"}
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteIdea(idea)}
                          className="rounded-full border border-red-400 px-3 py-1 text-xs font-semibold text-red-100 transition hover:bg-red-500/20"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <p className="mt-3 text-sm text-slate-300">{idea.description}</p>
                    {idea.prompt_snippet && (
                      <p className="mt-3 text-xs font-mono text-emerald-200 truncate">Prompt: {idea.prompt_snippet}</p>
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
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg">
            <h2 className="text-xl font-semibold text-white">Session Events</h2>
            <p className="text-sm text-slate-400">LLM Request/ResponseやLikeの履歴をJSONで確認できます。</p>
            <div className="mt-4 space-y-3">
              {events.length === 0 && (
                <div className="rounded-lg border border-dashed border-slate-700 bg-slate-900/60 p-4 text-center text-sm text-slate-400">
                  イベントはまだありません。
                </div>
              )}
              {events.map((event) => (
                <details
                  key={event.id}
                  className="rounded-lg border border-slate-800 bg-slate-950/60 p-4"
                  open={event.event_type === "LLM_REQUEST" || event.event_type === "LLM_RESPONSE"}
                >
                  <summary className="flex cursor-pointer items-center justify-between text-sm text-white">
                    <span className="font-semibold">{event.event_type}</span>
                    <span className="text-xs text-slate-400">{formatDate(event.created_at)}</span>
                  </summary>
                  <pre className="mt-3 overflow-auto rounded-lg bg-slate-900/80 p-3 text-xs text-emerald-100">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                </details>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function extractError(err: unknown) {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "詳細の取得に失敗しました。";
}
