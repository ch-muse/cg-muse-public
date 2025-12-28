import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError } from "../lib/api.js";
import type { SessionSummary } from "../types.js";

const formatDate = (value: string) => {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
};

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await api.fetchSessions();
        if (!active) return;
        setSessions(data.sessions);
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
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-400 uppercase tracking-[0.2em]">Internals</p>
          <h1 className="text-3xl font-semibold">Sessions</h1>
          <p className="text-sm text-slate-400">Museで生成したセッションの一覧です。</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            setError(null);
            api
              .fetchSessions()
              .then((data) => setSessions(data.sessions))
              .catch((err) => setError(extractError(err)))
              .finally(() => setLoading(false));
          }}
          className="rounded-md border border-slate-600 px-3 py-1 text-xs text-slate-200 hover:border-emerald-400 hover:text-emerald-100"
        >
          再読み込み
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-900/30 px-4 py-3 text-sm text-red-100">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 shadow-lg">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900/60 text-slate-300">
            <tr>
              <th className="px-4 py-3 font-semibold">作成日時</th>
              <th className="px-4 py-3 font-semibold">タイトル</th>
              <th className="px-4 py-3 font-semibold">モデル</th>
              <th className="px-4 py-3 font-semibold text-right">アイデア</th>
              <th className="px-4 py-3 font-semibold text-right">Liked</th>
              <th className="px-4 py-3 font-semibold text-right">詳細</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  読み込み中...
                </td>
              </tr>
            ) : sessions.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  セッションがまだありません。Museで生成すると表示されます。
                </td>
              </tr>
            ) : (
              sessions.map((session) => (
                <tr key={session.id} className="hover:bg-slate-800/50">
                  <td className="px-4 py-3 text-slate-400">{formatDate(session.created_at)}</td>
                  <td className="px-4 py-3 text-white">{session.title || "Untitled"}</td>
                  <td className="px-4 py-3 text-slate-300">{session.llm_model}</td>
                  <td className="px-4 py-3 text-right text-slate-200">{session.idea_count}</td>
                  <td className="px-4 py-3 text-right text-slate-200">{session.liked_count}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-3 text-xs">
                      <Link className="text-emerald-300 hover:text-emerald-200" to={`/internals/sessions/${session.id}`}>
                        詳細
                      </Link>
                      <button
                        type="button"
                        disabled={deleting.has(session.id)}
                        onClick={async () => {
                          if (!window.confirm("このセッションを削除しますか？")) return;
                          setDeleting((prev) => new Set(prev).add(session.id));
                          try {
                            await api.deleteSession(session.id);
                            setSessions((prev) => prev.filter((item) => item.id !== session.id));
                          } catch (err) {
                            setError(extractError(err));
                          } finally {
                            setDeleting((prev) => {
                              const next = new Set(prev);
                              next.delete(session.id);
                              return next;
                            });
                          }
                        }}
                        className="text-red-200 underline decoration-dotted disabled:opacity-60"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function extractError(err: unknown) {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "一覧の取得に失敗しました。";
}
