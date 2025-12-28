import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError, API_BASE_URL } from "../../lib/api.js";
import type { Recipe } from "../../types.js";

const formatDate = (value: string) => {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
};

export default function WorkshopRecipesList() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await api.fetchRecipes();
        if (!active) return;
        setRecipes(data.recipes);
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-400 uppercase tracking-[0.2em]">Workshop</p>
          <h1 className="text-3xl font-semibold">Recipes</h1>
          <p className="text-sm text-slate-400">Museのアイデアを実用プロンプトに整形します。</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/workshop/loras"
            className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100 hover:border-emerald-400 hover:text-emerald-100"
          >
            LoRA Library
          </Link>
          <Link
            to="/workshop/loras/new"
            className="rounded-md border border-emerald-400/60 px-3 py-2 text-sm text-emerald-100 hover:bg-emerald-500/10"
          >
            New LoRA
          </Link>
          <Link
            to="/workshop/recipes/new"
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
          >
            New Recipe
          </Link>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-900/30 px-4 py-3 text-sm text-red-100">{error}</div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 shadow-lg">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900/60 text-slate-300">
            <tr>
              <th className="px-4 py-3 font-semibold">Thumb</th>
              <th className="px-4 py-3 font-semibold">タイトル</th>
              <th className="px-4 py-3 font-semibold">Target</th>
              <th className="px-4 py-3 font-semibold">Pinned</th>
              <th className="px-4 py-3 font-semibold">LoRA数</th>
              <th className="px-4 py-3 font-semibold">更新日</th>
              <th className="px-4 py-3 font-semibold text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-slate-400">
                  読み込み中...
                </td>
              </tr>
            ) : recipes.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-slate-400">
                  Recipeがまだありません。右上の「新規作成」から追加してください。
                </td>
              </tr>
            ) : (
              recipes.map((recipe) => {
                const thumbUrl = recipe.thumbnail_key ? `${API_BASE_URL}/media/${recipe.thumbnail_key}` : null;
                return (
                  <tr key={recipe.id} className="hover:bg-slate-800/50">
                    <td className="px-4 py-3">
                      <div className="h-12 w-12 overflow-hidden rounded-lg border border-slate-700 bg-slate-800">
                        {thumbUrl ? (
                          <img src={thumbUrl} alt={recipe.title ?? "thumbnail"} className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-500">No image</div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-white">{recipe.title || "Untitled"}</td>
                    <td className="px-4 py-3 text-slate-200">{recipe.target}</td>
                    <td className="px-4 py-3 text-slate-200">{recipe.pinned ? "Yes" : "-"}</td>
                    <td className="px-4 py-3 text-slate-200">{recipe.lora_count ?? 0}</td>
                    <td className="px-4 py-3 text-slate-400">{formatDate(recipe.updated_at || recipe.created_at)}</td>
                    <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-3 text-xs">
                      <Link className="text-emerald-300 hover:text-emerald-200" to={`/workshop/recipes/${recipe.id}`}>
                        詳細
                      </Link>
                      <button
                        type="button"
                        disabled={deleting.has(recipe.id)}
                        onClick={async () => {
                          if (!window.confirm("このRecipeを削除しますか？")) return;
                          setDeleting((prev) => new Set(prev).add(recipe.id));
                          try {
                            await api.deleteRecipe(recipe.id);
                            setRecipes((prev) => prev.filter((item) => item.id !== recipe.id));
                          } catch (err) {
                            setError(extractError(err));
                          } finally {
                            setDeleting((prev) => {
                              const next = new Set(prev);
                              next.delete(recipe.id);
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
  return "Recipe一覧の取得に失敗しました。";
}
