import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiClientError, API_BASE_URL } from "../../lib/api.js";
import type { Lora } from "../../types.js";

const splitInput = (value: string) =>
  value
    .split(/,|\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const parseOptionalNumber = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : NaN;
};

export default function WorkshopLoraForm() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id;
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: "",
    triggerWords: "",
    recommendedWeightMin: "",
    recommendedWeightMax: "",
    notes: "",
    tags: "",
    examplePrompts: ""
  });
  const [lora, setLora] = useState<Lora | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [uploadingThumb, setUploadingThumb] = useState(false);

  useEffect(() => {
    if (!id) return;
    let active = true;
    const load = async () => {
      try {
        setLoading(true);
        const data = await api.fetchLora(id);
        if (!active) return;
        setLora(data.lora);
        setForm({
          name: data.lora.name,
          triggerWords: data.lora.trigger_words.join(", "),
          recommendedWeightMin: data.lora.recommended_weight_min !== null ? String(data.lora.recommended_weight_min) : "",
          recommendedWeightMax: data.lora.recommended_weight_max !== null ? String(data.lora.recommended_weight_max) : "",
          notes: data.lora.notes ?? "",
          tags: data.lora.tags.join(", "),
          examplePrompts: data.lora.example_prompts.join("\n")
        });
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

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    if (!form.name.trim()) {
      setError("名前は必須です。");
      return;
    }

    const weightMin = parseOptionalNumber(form.recommendedWeightMin);
    const weightMax = parseOptionalNumber(form.recommendedWeightMax);
    if (Number.isNaN(weightMin) || Number.isNaN(weightMax)) {
      setError("weightは数値で入力してください。");
      return;
    }

    const payload = {
      name: form.name.trim(),
      triggerWords: splitInput(form.triggerWords),
      recommendedWeightMin: weightMin,
      recommendedWeightMax: weightMax,
      notes: form.notes.trim() ? form.notes.trim() : null,
      tags: splitInput(form.tags),
      examplePrompts: splitInput(form.examplePrompts)
    };

    try {
      setSaving(true);
      if (isNew) {
        const created = await api.createLora(payload);
        navigate(`/workshop/loras/${created.lora.id}`);
      } else if (id) {
        const updated = await api.updateLora(id, payload);
        setLora(updated.lora);
        setSuccess(`保存しました: ${updated.lora.name}`);
      }
    } catch (err) {
      setError(extractError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    if (!window.confirm("このLoRAを削除しますか？紐づくRecipeとの関連も削除されます。")) return;
    try {
      await api.deleteLora(id);
      navigate("/workshop/loras");
    } catch (err) {
      setError(extractError(err));
    }
  };

  const handleUpload = async () => {
    if (!id) return;
    if (!thumbnailFile) {
      setError("ファイルを選択してください。");
      return;
    }
    setError(null);
    setSuccess(null);
    try {
      setUploadingThumb(true);
      const result = await api.uploadLoraThumbnail(id, thumbnailFile);
      setLora(result.lora);
      setSuccess("サムネイルを更新しました。");
      setThumbnailFile(null);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setUploadingThumb(false);
    }
  };

  const thumbnailUrl = lora?.thumbnail_key ? `${API_BASE_URL}/media/${lora.thumbnail_key}` : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-400 uppercase tracking-[0.2em]">Workshop</p>
          <h1 className="text-3xl font-semibold">{isNew ? "LoRAを追加" : "LoRAを編集"}</h1>
          <p className="text-sm text-slate-400">トリガーワードや推奨重みを整理します。</p>
        </div>
        <div className="flex items-center gap-3">
          <Link className="text-sm text-emerald-300 underline decoration-dotted" to="/workshop/loras">
            一覧へ戻る
          </Link>
          {!isNew && (
            <button
              type="button"
              onClick={handleDelete}
              className="rounded-md border border-red-500/60 px-3 py-2 text-xs font-semibold text-red-100 hover:bg-red-500/10"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-900/30 px-4 py-3 text-sm text-red-100">{error}</div>
      )}
      {success && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-900/20 px-4 py-3 text-sm text-emerald-100">
          {success}
        </div>
      )}

      {!isNew ? (
        <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">Thumbnail</h2>
              <p className="text-sm text-slate-400">png / jpeg / webp（5MBまで、1枚のみ）</p>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex justify-center md:col-span-1">
              <div className="aspect-square w-full max-w-xs overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
                {thumbnailUrl ? (
                  <img src={thumbnailUrl} alt="thumbnail" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-sm text-slate-500">No thumbnail</div>
                )}
              </div>
            </div>
            <div className="space-y-3 md:col-span-2">
              <label className="block text-sm text-slate-200">
                <span className="text-slate-200">Upload new thumbnail</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => setThumbnailFile(event.target.files?.[0] ?? null)}
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none file:mr-3 file:rounded-md file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-sm file:text-slate-200"
                />
              </label>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                <button
                  type="button"
                  onClick={handleUpload}
                  disabled={uploadingThumb || !thumbnailFile}
                  className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300"
                >
                  {uploadingThumb ? "Uploading..." : "Upload"}
                </button>
                <span>アップロードすると既存のサムネイルが置き換わります。</span>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <p className="text-xs text-slate-400">サムネイルは保存後にアップロードできます。</p>
      )}

      <form
        onSubmit={handleSubmit}
        className="space-y-5 rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg"
      >
        {loading ? (
          <p className="text-sm text-slate-400">読み込み中...</p>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block text-sm">
                <span className="text-slate-200">名前 *</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  placeholder="例: dreamy-portrait-lora"
                  required
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-200">Trigger Words（カンマ区切り）</span>
                <input
                  type="text"
                  value={form.triggerWords}
                  onChange={(event) => setForm((prev) => ({ ...prev, triggerWords: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  placeholder="lora:token1, token2"
                />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block text-sm">
                <span className="text-slate-200">推奨 weight min</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={form.recommendedWeightMin}
                  onChange={(event) => setForm((prev) => ({ ...prev, recommendedWeightMin: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  placeholder="0.6"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-200">推奨 weight max</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={form.recommendedWeightMax}
                  onChange={(event) => setForm((prev) => ({ ...prev, recommendedWeightMax: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  placeholder="0.9"
                />
              </label>
            </div>

            <label className="block text-sm">
              <span className="text-slate-200">Notes</span>
              <textarea
                value={form.notes}
                onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
                rows={3}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                placeholder="使い方メモなど"
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block text-sm">
                <span className="text-slate-200">Tags（カンマ区切り）</span>
                <input
                  type="text"
                  value={form.tags}
                  onChange={(event) => setForm((prev) => ({ ...prev, tags: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  placeholder="portrait, cyberpunk"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-200">Example Prompts（改行区切り）</span>
                <textarea
                  value={form.examplePrompts}
                  onChange={(event) => setForm((prev) => ({ ...prev, examplePrompts: event.target.value }))}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  placeholder="例: masterful portrait, 8k..."
                />
              </label>
            </div>

            <div className="flex justify-end gap-3">
              <button
                type="submit"
                disabled={saving}
                className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
              >
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

function extractError(err: unknown) {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "LoRAの操作に失敗しました。";
}
