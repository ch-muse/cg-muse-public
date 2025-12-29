import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError, API_BASE_URL } from "../../lib/api.js";
import type { Lora } from "../../types.js";

const formatDate = (value: string) => {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
};

const summarize = (items: string[], max = 3) => {
  if (!items || items.length === 0) return "-";
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} (+${items.length - max})`;
};

const normalize = (value: string) => value.trim().toLowerCase();

export default function WorkshopLorasList() {
  const [loras, setLoras] = useState<Lora[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await api.fetchLoras();
        if (!active) return;
        setLoras(data.loras);
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

  const filteredLoras = useMemo(() => {
    const term = normalize(filterText);
    if (!term) return loras;
    return loras.filter((lora) => {
      const fields = [
        lora.name,
        lora.fileName ?? "",
        ...(lora.trigger_words ?? []),
        ...(Array.isArray(lora.tags) ? lora.tags : [])
      ].map((value) => normalize(String(value || "")));
      return fields.some((field) => field.includes(term));
    });
  }, [filterText, loras]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-400 uppercase tracking-[0.2em]">Workshop</p>
          <h1 className="text-3xl font-semibold">LoRA Library</h1>
          <p className="text-sm text-slate-400">名称・トリガーワード・推奨重みを整理します。</p>
        </div>
        <Link
          to="/workshop/loras/new"
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
        >
          新規作成
        </Link>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex w-full flex-col gap-1 sm:max-w-sm">
          <span className="text-xs uppercase tracking-wide text-slate-400">Search</span>
          <input
            type="text"
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            placeholder="Search LoRAs (name, trigger, tag)"
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
            disabled={loras.length === 0}
          />
        </label>
        <div className="text-xs text-slate-400">{filteredLoras.length} results</div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-900/30 px-4 py-3 text-sm text-red-100">{error}</div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 shadow-lg">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900/60 text-slate-300">
            <tr>
              <th className="px-4 py-3 font-semibold">Thumb</th>
              <th className="px-4 py-3 font-semibold">名前</th>
              <th className="px-4 py-3 font-semibold">Trigger Words</th>
              <th className="px-4 py-3 font-semibold">Tags</th>
              <th className="px-4 py-3 font-semibold">更新日</th>
              <th className="px-4 py-3 font-semibold text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  読み込み中...
                </td>
              </tr>
            ) : loras.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  LoRAがまだありません。右上の「新規作成」から追加してください。
                </td>
              </tr>
            ) : filteredLoras.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-300">
                  <div className="space-y-2">
                    <p>No matches</p>
                    <Link
                      to="/workshop/loras/new"
                      className="inline-flex items-center justify-center rounded-md border border-emerald-400/60 px-3 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/10"
                    >
                      LoRAを登録する
                    </Link>
                  </div>
                </td>
              </tr>
            ) : (
              filteredLoras.map((lora) => {
                const thumbUrl = lora.thumbnail_key ? `${API_BASE_URL}/media/${lora.thumbnail_key}` : null;
                return (
                  <tr key={lora.id} className="hover:bg-slate-800/50">
                    <td className="px-4 py-3">
                      <div className="h-12 w-12 overflow-hidden rounded-lg border border-slate-700 bg-slate-800">
                        {thumbUrl ? (
                          <img src={thumbUrl} alt={lora.name} className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-500">No image</div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        <div className="text-white">{lora.name}</div>
                        {lora.fileName ? <div className="text-xs text-slate-400">{lora.fileName}</div> : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-200">{summarize(lora.trigger_words)}</td>
                    <td className="px-4 py-3 text-slate-200">{summarize(lora.tags)}</td>
                    <td className="px-4 py-3 text-slate-400">{formatDate(lora.updated_at || lora.created_at)}</td>
                    <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-3 text-xs">
                      <Link className="text-emerald-300 hover:text-emerald-200" to={`/workshop/loras/${lora.id}`}>
                        編集
                      </Link>
                      <button
                        type="button"
                        disabled={deleting.has(lora.id)}
                        onClick={async () => {
                          if (!window.confirm("このLoRAを削除しますか？紐づくRecipeとの関連も消えます。")) return;
                          setDeleting((prev) => new Set(prev).add(lora.id));
                          try {
                            await api.deleteLora(lora.id);
                            setLoras((prev) => prev.filter((item) => item.id !== lora.id));
                          } catch (err) {
                            setError(extractError(err));
                          } finally {
                            setDeleting((prev) => {
                              const next = new Set(prev);
                              next.delete(lora.id);
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
  return "LoRA一覧の取得に失敗しました。";
}
