import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError } from "../lib/api.js";
import type { LikedIdea } from "../types.js";

const formatDate = (value?: string | null) => {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value ?? "-";
  }
};

export default function LikedIdeasPage() {
  const [ideas, setIdeas] = useState<LikedIdea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<Set<string>>(new Set());

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.fetchLikedIdeas();
      setIdeas(data.ideas);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const runUpdate = async (id: string, fn: () => Promise<void>) => {
    setUpdating((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      await fn();
    } finally {
      setUpdating((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleUnlike = (idea: LikedIdea) => {
    runUpdate(idea.id, async () => {
      await api.toggleIdeaLike(idea.id, false);
      setIdeas((prev) => prev.filter((item) => item.id !== idea.id));
    }).catch((err) => setError(extractError(err)));
  };

  const handleDelete = (idea: LikedIdea) => {
    if (!window.confirm("このアイデアを削除しますか？")) return;
    runUpdate(idea.id, async () => {
      await api.deleteIdea(idea.id);
      setIdeas((prev) => prev.filter((item) => item.id !== idea.id));
    }).catch((err) => setError(extractError(err)));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-400 uppercase tracking-[0.2em]">Play</p>
          <h1 className="text-3xl font-semibold">Liked Ideas</h1>
          <p className="text-sm text-slate-400">いいね済みのアイデアを横断して確認できます。</p>
        </div>
        <button
          type="button"
          onClick={load}
          className="rounded-md border border-slate-600 px-3 py-1 text-xs text-slate-200 hover:border-emerald-400 hover:text-emerald-100"
        >
          再読み込み
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-900/30 px-4 py-3 text-sm text-red-100">{error}</div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 shadow-lg">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900/60 text-slate-300">
            <tr>
              <th className="px-4 py-3 font-semibold">タイトル</th>
              <th className="px-4 py-3 font-semibold">セッション</th>
              <th className="px-4 py-3 font-semibold">モデル</th>
              <th className="px-4 py-3 font-semibold">作成日時</th>
              <th className="px-4 py-3 font-semibold text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  読み込み中...
                </td>
              </tr>
            ) : ideas.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  いいね済みのアイデアはありません。
                </td>
              </tr>
            ) : (
              ideas.map((idea) => {
                const pending = updating.has(idea.id);
                return (
                  <tr key={idea.id} className="hover:bg-slate-800/50">
                    <td className="px-4 py-3 text-white">{idea.title}</td>
                    <td className="px-4 py-3 text-slate-300">{idea.session_title || "Untitled Session"}</td>
                    <td className="px-4 py-3 text-slate-300">{idea.session_llm_model}</td>
                    <td className="px-4 py-3 text-slate-400">{formatDate(idea.created_at)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-3">
                        <Link className="text-emerald-300 hover:text-emerald-200 text-xs" to={`/internals/sessions/${idea.session_id}`}>
                          Internals
                        </Link>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => handleUnlike(idea)}
                          className="text-xs text-amber-200 underline decoration-dotted disabled:opacity-60"
                        >
                          Unlike
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => handleDelete(idea)}
                          className="text-xs text-red-200 underline decoration-dotted disabled:opacity-60"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
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
  return "取得に失敗しました。";
}
