import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useLocation } from "react-router-dom";
import { api, ApiClientError, API_BASE_URL } from "../../lib/api.js";
import PromptComposer from "../../components/prompt/PromptComposer.js";
import type { GalleryItem, Lora, Recipe, RecipeLoraLink, RecipeTarget } from "../../types.js";

const targetOptions: RecipeTarget[] = ["SDXL", "COMFYUI_BLOCKS"];
const normalize = (value: string) => value.trim().toLowerCase();

const splitTags = (value: string) =>
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

const safeJsonStringify = (value: unknown) => {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
};

type RecipeRun = {
  id: string;
  status?: string | null;
  prompt_id?: string | null;
  request_json?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
};

const RUN_SUBMIT_TIMEOUT_MS = 12_000;
const RUNS_FETCH_TIMEOUT_MS = 8_000;
const RUNS_POLL_INTERVAL_MS = 2_500;
const GALLERY_FETCH_TIMEOUT_MS = 8_000;
const GALLERY_FETCH_LIMIT = 36;

export default function WorkshopRecipeForm() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const location = useLocation();

  const [form, setForm] = useState({
    title: "",
    target: targetOptions[0],
    positive: "",
    negative: "",
    notes: "",
    variablesText: "{}",
    tags: "",
    pinned: false,
    sourceIdeaId: ""
  });
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [linkedLoras, setLinkedLoras] = useState<RecipeLoraLink[]>([]);
  const [availableLoras, setAvailableLoras] = useState<Lora[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [uploadingThumb, setUploadingThumb] = useState(false);
  const [taggerLoading, setTaggerLoading] = useState(false);
  const [taggerError, setTaggerError] = useState<string | null>(null);
  const [taggerMessage, setTaggerMessage] = useState<string | null>(null);
  const [runSubmitting, setRunSubmitting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [recipeRuns, setRecipeRuns] = useState<RecipeRun[]>([]);
  const [runsPhase, setRunsPhase] = useState<"idle" | "fetching" | "success" | "error">("idle");
  const [runsError, setRunsError] = useState<string | null>(null);
  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([]);
  const [galleryPhase, setGalleryPhase] = useState<"idle" | "fetching" | "success" | "error">("idle");
  const [galleryError, setGalleryError] = useState<string | null>(null);

  const activeRef = useRef(true);
  const runSubmitInFlightRef = useRef(false);
  const runSubmitRequestIdRef = useRef(0);
  const runSubmitAbortRef = useRef<AbortController | null>(null);
  const runsInFlightRef = useRef(false);
  const runsRequestIdRef = useRef(0);
  const runsAbortRef = useRef<AbortController | null>(null);
  const runsPollTimeoutRef = useRef<number | null>(null);
  const runsRef = useRef<RecipeRun[]>([]);
  const runsActiveRef = useRef(false);
  const galleryInFlightRef = useRef(false);
  const galleryRequestIdRef = useRef(0);
  const galleryAbortRef = useRef<AbortController | null>(null);

  const [linkForm, setLinkForm] = useState({
    loraId: "",
    weight: "",
    usageNotes: "",
    sortOrder: "0"
  });

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      runSubmitAbortRef.current?.abort();
      runsAbortRef.current?.abort();
      galleryAbortRef.current?.abort();
      if (runsPollTimeoutRef.current) {
        window.clearTimeout(runsPollTimeoutRef.current);
        runsPollTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let active = true;
    api
      .fetchLoras()
      .then((data) => {
        if (active) setAvailableLoras(data.loras);
      })
      .catch((err) => {
        if (active) setError(extractError(err));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const state = location.state as { thumbUploadError?: string } | null;
    if (!state?.thumbUploadError) return;
    setError(state.thumbUploadError);
    navigate(location.pathname, { replace: true, state: null });
  }, [location, navigate]);

  const filteredLoras = useMemo(() => {
    const term = normalize(filterText);
    if (!term) return availableLoras;
    return availableLoras.filter((lora) => {
      const fields = [
        lora.name,
        ...(lora.trigger_words ?? []),
        ...(Array.isArray(lora.tags) ? lora.tags : [])
      ].map((value) => normalize(String(value || "")));
      return fields.some((field) => field.includes(term));
    });
  }, [availableLoras, filterText]);

  const selectedLora = useMemo(
    () => availableLoras.find((item) => item.id === linkForm.loraId) || null,
    [availableLoras, linkForm.loraId]
  );

  const hasSelectedOutsideFilter = useMemo(
    () => Boolean(selectedLora && !filteredLoras.some((item) => item.id === selectedLora.id)),
    [filteredLoras, selectedLora]
  );

  const displayLoras = useMemo(() => {
    if (selectedLora && !filteredLoras.some((item) => item.id === selectedLora.id)) {
      return [selectedLora, ...filteredLoras];
    }
    return filteredLoras;
  }, [filteredLoras, selectedLora]);

  const recipeThumbnailUrl = useMemo(() => {
    if (recipe?.thumbnail_key) return `${API_BASE_URL}/media/${recipe.thumbnail_key}`;
    const fallback = linkedLoras.find((item) => item.lora_thumbnail_key);
    return fallback?.lora_thumbnail_key ? `${API_BASE_URL}/media/${fallback.lora_thumbnail_key}` : null;
  }, [linkedLoras, recipe]);

  useEffect(() => {
    if (!id) return;
    let active = true;
    const load = async () => {
      try {
        setLoading(true);
        const data = await api.fetchRecipe(id);
        if (!active) return;
        setRecipe(data.recipe);
        setLinkedLoras(data.loras);
        setForm({
          title: data.recipe.title ?? "",
          target: data.recipe.target,
          positive: (data.recipe.prompt_blocks?.positive as string) || "",
          negative: (data.recipe.prompt_blocks?.negative as string) || "",
          notes: (data.recipe.prompt_blocks?.notes as string) || "",
          variablesText: safeJsonStringify(data.recipe.variables),
          tags: (data.recipe.tags ?? []).join(", "),
          pinned: data.recipe.pinned,
          sourceIdeaId: data.recipe.source_idea_id ?? ""
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
    setTaggerError(null);
    setTaggerMessage(null);

    let variables: Record<string, unknown> = {};
    try {
      variables = form.variablesText.trim() ? JSON.parse(form.variablesText) : {};
    } catch (err) {
      setError("variables は JSON 形式で入力してください。");
      return;
    }

    const tags = splitTags(form.tags);
    const promptBlocks = {
      positive: form.positive ?? "",
      negative: form.negative ?? "",
      notes: form.notes ?? ""
    };
    const sourceIdeaId = form.sourceIdeaId.trim();

    try {
      setSaving(true);
      if (isNew) {
        if (sourceIdeaId && [form.positive, form.negative, form.notes].some((v) => v.trim().length > 0)) {
          setError("Import（sourceIdeaId）と直接入力の併用は避けてください。");
          return;
        }
        const payload = sourceIdeaId
          ? {
              sourceIdeaId,
              target: form.target as RecipeTarget,
              title: form.title.trim() || undefined,
              variables,
              tags,
              pinned: form.pinned
            }
          : {
              title: form.title.trim() || undefined,
              target: form.target as RecipeTarget,
              promptBlocks,
              variables,
              tags,
              pinned: form.pinned
            };
        const created = await api.createRecipe(payload);
        let thumbUploadError: string | null = null;
        if (thumbnailFile) {
          try {
            await api.uploadRecipeThumbnail(created.recipe.id, thumbnailFile);
          } catch (err) {
            thumbUploadError = `サムネイルのアップロードに失敗しました: ${extractError(err)}`;
          }
        }
        navigate(`/workshop/recipes/${created.recipe.id}`, {
          state: thumbUploadError ? { thumbUploadError } : null
        });
      } else if (id) {
        const updated = await api.updateRecipe(id, {
          title: form.title.trim() || undefined,
          target: form.target as RecipeTarget,
          promptBlocks,
          variables,
          tags,
          pinned: form.pinned,
          sourceIdeaId: sourceIdeaId || null
        });
        setRecipe(updated.recipe);
        setSuccess("保存しました。");
      }
    } catch (err) {
      setError(extractError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    if (!window.confirm("このRecipeを削除しますか？")) return;
    try {
      await api.deleteRecipe(id);
      navigate("/workshop/recipes");
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
      const result = await api.uploadRecipeThumbnail(id, thumbnailFile);
      setRecipe(result.recipe);
      setSuccess("サムネイルを更新しました。");
      setThumbnailFile(null);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setUploadingThumb(false);
    }
  };

  const handleRunTagger = async () => {
    if (!thumbnailFile) {
      setTaggerError("画像を選択してください。");
      return;
    }
    setTaggerLoading(true);
    setTaggerError(null);
    setTaggerMessage(null);
    try {
      const result = await api.runComfyTagger(thumbnailFile);
      const tags = result.tags?.trim() || "";
      if (!tags) {
        setTaggerError("タグが取得できませんでした。");
        return;
      }
      setForm((prev) => ({ ...prev, positive: tags }));
      setTaggerMessage("Positive にタグを反映しました。");
    } catch (err) {
      setTaggerError(extractError(err));
    } finally {
      setTaggerLoading(false);
    }
  };

  const fetchRecipeGallery = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!id) return;
      if (galleryInFlightRef.current) return;
      galleryInFlightRef.current = true;
      const requestId = galleryRequestIdRef.current + 1;
      galleryRequestIdRef.current = requestId;
      galleryAbortRef.current?.abort();
      const controller = new AbortController();
      galleryAbortRef.current = controller;
      const timeoutId = window.setTimeout(() => controller.abort(), GALLERY_FETCH_TIMEOUT_MS);

      if (!options?.silent) {
        setGalleryPhase("fetching");
        setGalleryError(null);
      }

      let rawText = "";
      try {
        const url = `${API_BASE_URL}/api/gallery/items?limit=${GALLERY_FETCH_LIMIT}`;
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        rawText = await response.text();

        if (!activeRef.current || requestId !== galleryRequestIdRef.current) {
          return;
        }

        let json: any = null;
        if (rawText.trim()) {
          try {
            json = JSON.parse(rawText);
          } catch (err) {
            setGalleryPhase("error");
            setGalleryError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
        }

        if (!response.ok) {
          setGalleryPhase("error");
          setGalleryError(json?.error?.message || `HTTP ${response.status}`);
          return;
        }

        if (!json || json.ok !== true) {
          setGalleryPhase("error");
          setGalleryError(json?.error?.message || "Gallery request failed");
          return;
        }

        const list = Array.isArray(json?.data?.items) ? (json.data.items as GalleryItem[]) : [];
        const filtered = list.filter((item) => item.recipe_id === id);
        setGalleryItems(filtered);
        setGalleryPhase("success");
        setGalleryError(null);
      } catch (err) {
        if (!activeRef.current || requestId !== galleryRequestIdRef.current) {
          return;
        }
        const isTimeout = err instanceof Error && err.name === "AbortError";
        setGalleryPhase("error");
        setGalleryError(isTimeout ? "gallery timeout" : err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timeoutId);
        if (galleryRequestIdRef.current === requestId) {
          galleryInFlightRef.current = false;
        }
      }
    },
    [id]
  );

  const fetchRecipeRuns = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!id) return;
      if (runsInFlightRef.current) return;
      runsInFlightRef.current = true;
      const requestId = runsRequestIdRef.current + 1;
      runsRequestIdRef.current = requestId;
      runsAbortRef.current?.abort();
      const controller = new AbortController();
      runsAbortRef.current = controller;
      const timeoutId = window.setTimeout(() => controller.abort(), RUNS_FETCH_TIMEOUT_MS);

      if (!options?.silent) {
        setRunsPhase("fetching");
        setRunsError(null);
      }

      let rawText = "";
      let list: RecipeRun[] = [];
      try {
        const url = `${API_BASE_URL}/api/comfy/runs?recipeId=${encodeURIComponent(id)}`;
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        rawText = await response.text();

        if (!activeRef.current || requestId !== runsRequestIdRef.current) {
          return;
        }

        let json: any = null;
        if (rawText.trim()) {
          try {
            json = JSON.parse(rawText);
          } catch (err) {
            setRunsPhase("error");
            setRunsError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
        }

        if (!response.ok) {
          setRunsPhase("error");
          setRunsError(json?.error?.message || `HTTP ${response.status}`);
          return;
        }

        if (!json || json.ok !== true) {
          setRunsPhase("error");
          setRunsError(json?.error?.message || "Runs request failed");
          return;
        }

        list = Array.isArray(json?.data?.runs) ? (json.data.runs as RecipeRun[]) : [];
        setRecipeRuns(list);
        runsRef.current = list;
        setRunsPhase("success");
        setRunsError(null);
      } catch (err) {
        if (!activeRef.current || requestId !== runsRequestIdRef.current) {
          return;
        }
        const isTimeout = err instanceof Error && err.name === "AbortError";
        setRunsPhase("error");
        setRunsError(isTimeout ? "runs timeout" : err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timeoutId);
        if (runsRequestIdRef.current === requestId) {
          runsInFlightRef.current = false;
        }
      }

      if (!activeRef.current || requestId !== runsRequestIdRef.current) {
        return;
      }

      const hasActive = list.length > 0 ? list.some((run) => isRunActive(run.status)) : runsRef.current.some((run) => isRunActive(run.status));
      const wasActive = runsActiveRef.current;
      runsActiveRef.current = hasActive;

      if (wasActive && !hasActive) {
        void fetchRecipeGallery({ silent: true });
      }

      if (hasActive && !runsPollTimeoutRef.current) {
        runsPollTimeoutRef.current = window.setTimeout(() => {
          runsPollTimeoutRef.current = null;
          void fetchRecipeRuns({ silent: true });
        }, RUNS_POLL_INTERVAL_MS);
      }
    },
    [fetchRecipeGallery, id]
  );

  const handleRunRecipe = useCallback(async () => {
    if (!id) return;
    if (runSubmitInFlightRef.current) return;
    runSubmitInFlightRef.current = true;
    setRunSubmitting(true);
    setRunError(null);
    setRunMessage(null);

    const requestId = runSubmitRequestIdRef.current + 1;
    runSubmitRequestIdRef.current = requestId;
    runSubmitAbortRef.current?.abort();
    const controller = new AbortController();
    runSubmitAbortRef.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), RUN_SUBMIT_TIMEOUT_MS);

    try {
      const url = `${API_BASE_URL}/api/workshop/recipes/${encodeURIComponent(id)}/run`;
      const response = await fetch(url, { method: "POST", signal: controller.signal, cache: "no-store" });
      const rawText = await response.text();

      if (!activeRef.current || requestId !== runSubmitRequestIdRef.current) {
        return;
      }

      let json: any = null;
      if (rawText.trim()) {
        try {
          json = JSON.parse(rawText);
        } catch (err) {
          setRunError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }

      if (!response.ok) {
        setRunError(json?.error?.message || `HTTP ${response.status}`);
        return;
      }

      if (!json || json.ok !== true) {
        setRunError(json?.error?.message || "Run request failed");
        return;
      }

      const run = json?.data?.run as RecipeRun | undefined;
      setRunMessage(run?.id ? `Runを作成しました: ${run.id}` : "Runを作成しました。");
      void fetchRecipeRuns();
      void fetchRecipeGallery({ silent: true });
    } catch (err) {
      if (!activeRef.current || requestId !== runSubmitRequestIdRef.current) {
        return;
      }
      const isTimeout = err instanceof Error && err.name === "AbortError";
      setRunError(isTimeout ? "run timeout" : err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timeoutId);
      if (runSubmitRequestIdRef.current === requestId) {
        runSubmitInFlightRef.current = false;
        setRunSubmitting(false);
      }
    }
  }, [fetchRecipeGallery, fetchRecipeRuns, id]);

  useEffect(() => {
    if (!id || isNew) return;
    runsRef.current = [];
    runsActiveRef.current = false;
    if (runsPollTimeoutRef.current) {
      window.clearTimeout(runsPollTimeoutRef.current);
      runsPollTimeoutRef.current = null;
    }
    void fetchRecipeRuns();
    void fetchRecipeGallery();
    return () => {
      runsAbortRef.current?.abort();
      galleryAbortRef.current?.abort();
      if (runsPollTimeoutRef.current) {
        window.clearTimeout(runsPollTimeoutRef.current);
        runsPollTimeoutRef.current = null;
      }
    };
  }, [fetchRecipeGallery, fetchRecipeRuns, id, isNew]);

  const handleLinkLora = async (event: FormEvent) => {
    event.preventDefault();
    if (!id) return;
    if (!linkForm.loraId) {
      setError("LoRAを選択してください。");
      return;
    }
    const weight = parseOptionalNumber(linkForm.weight);
    if (Number.isNaN(weight)) {
      setError("weightは数値で入力してください。");
      return;
    }
    const sortOrderNum = Number.isFinite(Number(linkForm.sortOrder)) ? Number(linkForm.sortOrder) : 0;

    try {
      const result = await api.upsertRecipeLora(id, {
        loraId: linkForm.loraId,
        weight,
        usageNotes: linkForm.usageNotes.trim() ? linkForm.usageNotes.trim() : null,
        sortOrder: sortOrderNum
      });
      setLinkedLoras((prev) => {
        const next = prev.filter((item) => item.lora_id !== result.lora.lora_id);
        next.push(result.lora);
        return next.sort((a, b) => a.sort_order - b.sort_order || a.lora_name.localeCompare(b.lora_name));
      });
      setSuccess("LoRAを追加/更新しました。");
    } catch (err) {
      setError(extractError(err));
    }
  };

  const handleRemoveLora = async (loraId: string) => {
    if (!id) return;
    if (!window.confirm("このLoRAの紐づけを削除しますか？")) return;
    try {
      await api.deleteRecipeLora(id, loraId);
      setLinkedLoras((prev) => prev.filter((item) => item.lora_id !== loraId));
    } catch (err) {
      setError(extractError(err));
    }
  };

  const exportText = useMemo(() => {
    if (!recipe) return "";
    const lines: string[] = [];
    lines.push(`Recipe: ${recipe.title || "Untitled"} [${recipe.target}]`);
    lines.push("");
    lines.push("LoRAs:");
    if (linkedLoras.length === 0) {
      lines.push("- (none)");
    } else {
      linkedLoras.forEach((item) => {
        const triggers = item.trigger_words?.length ? ` | triggers: ${item.trigger_words.join(", ")}` : "";
        const weight = item.weight !== null ? ` | weight: ${item.weight}` : "";
        lines.push(`- ${item.lora_name}${weight}${triggers}`);
        if (item.usage_notes) lines.push(`  usage: ${item.usage_notes}`);
      });
    }
    lines.push("");
    lines.push("Prompts:");
    lines.push(`Positive:\n${(recipe.prompt_blocks?.positive as string) || ""}`);
    lines.push("");
    lines.push(`Negative:\n${(recipe.prompt_blocks?.negative as string) || ""}`);
    lines.push("");
    lines.push(`Notes:\n${(recipe.prompt_blocks?.notes as string) || ""}`);
    lines.push("");
    lines.push("Variables:");
    lines.push(safeJsonStringify(recipe.variables));
    return lines.join("\n");
  }, [linkedLoras, recipe]);

  const copyExport = async () => {
    if (!exportText) return;
    try {
      await navigator.clipboard.writeText(exportText);
      setSuccess("Exportテキストをコピーしました。");
    } catch {
      setError("コピーに失敗しました。");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-400 uppercase tracking-[0.2em]">Workshop</p>
          <h1 className="text-3xl font-semibold">{isNew ? "Recipeを作成" : "Recipeを編集"}</h1>
          <p className="text-sm text-slate-400">ターゲットとプロンプトブロックを整形し、LoRAを紐づけます。</p>
        </div>
        <div className="flex items-center gap-3">
          <Link className="text-sm text-emerald-300 underline decoration-dotted" to="/workshop/recipes">
            Back to Recipes
          </Link>
          <Link className="text-sm text-emerald-300 underline decoration-dotted" to="/workshop/loras">
            LoRA Library
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
      {!isNew && recipe && (
        <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-white">Run</h2>
              <p className="text-sm text-slate-400">Recipeをそのまま実行し、Run履歴を生成します。</p>
            </div>
            <button
              type="button"
              onClick={handleRunRecipe}
              disabled={runSubmitting}
              className="rounded-lg bg-emerald-400 px-6 py-3 text-base font-semibold text-slate-950 shadow hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300"
            >
              {runSubmitting ? "実行中..." : "Run Recipe"}
            </button>
          </div>
          {runError && <div className="text-sm text-red-200">Error: {runError}</div>}
          {runMessage && <div className="text-sm text-emerald-200">{runMessage}</div>}
        </section>
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
                {recipeThumbnailUrl ? (
                  <img src={recipeThumbnailUrl} alt="thumbnail" className="h-full w-full object-cover" />
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
        <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg">
          <div>
            <h2 className="text-xl font-semibold text-white">Tagger（画像 → Positive 反映）</h2>
            <p className="text-sm text-slate-400">この画像は作成後のサムネイルとしても保存されます。</p>
          </div>
          <div className="space-y-3">
            <label className="block text-sm text-slate-200">
              <span className="text-slate-200">Image</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  setThumbnailFile(event.target.files?.[0] ?? null);
                  setTaggerError(null);
                  setTaggerMessage(null);
                }}
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none file:mr-3 file:rounded-md file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-sm file:text-slate-200"
              />
            </label>
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
              <button
                type="button"
                onClick={handleRunTagger}
                disabled={taggerLoading || !thumbnailFile}
                className="rounded-md border border-emerald-400/60 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-400"
              >
                {taggerLoading ? "Tagger 実行中..." : "Run tagger"}
              </button>
              {thumbnailFile && <span>Selected: {thumbnailFile.name}</span>}
            </div>
            {taggerError && <p className="text-sm text-red-200">Error: {taggerError}</p>}
            {taggerMessage && <p className="text-sm text-emerald-200">{taggerMessage}</p>}
          </div>
        </section>
      )}
      {isNew && (
        <p className="text-xs text-slate-400">
          先にLoRAを登録したい場合は「LoRA Library」から追加できます（後から紐づけ可能）。
        </p>
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
                <span className="text-slate-200">タイトル（任意）</span>
                <input
                  type="text"
                  value={form.title}
                  onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  placeholder="例: Cyber city SDXL"
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block text-sm sm:col-span-2">
                  <span className="text-slate-200">Target</span>
                  <select
                    value={form.target}
                    onChange={(event) => setForm((prev) => ({ ...prev, target: event.target.value as RecipeTarget }))}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  >
                    {targetOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mt-1 flex items-center gap-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={form.pinned}
                    onChange={(event) => setForm((prev) => ({ ...prev, pinned: event.target.checked }))}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-emerald-500 focus:ring-emerald-400"
                  />
                  <span>Pinned</span>
                </label>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block text-sm">
                <span className="text-slate-200">Import from Idea (sourceIdeaId)</span>
                <input
                  type="text"
                  value={form.sourceIdeaId}
                  onChange={(event) => setForm((prev) => ({ ...prev, sourceIdeaId: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  placeholder="Idea UUID（任意）"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-200">Tags（カンマ区切り）</span>
                <input
                  type="text"
                  value={form.tags}
                  onChange={(event) => setForm((prev) => ({ ...prev, tags: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  placeholder="portrait, night city"
                />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="md:col-span-1">
                <PromptComposer
                  label="Prompt Positive"
                  target="positive"
                  value={form.positive}
                  onChange={(value) => setForm((prev) => ({ ...prev, positive: value }))}
                  onClear={() => setForm((prev) => ({ ...prev, positive: "" }))}
                  placeholder="Add tags..."
                />
              </div>
              <div className="md:col-span-1">
                <PromptComposer
                  label="Prompt Negative"
                  target="negative"
                  value={form.negative}
                  onChange={(value) => setForm((prev) => ({ ...prev, negative: value }))}
                  onClear={() => setForm((prev) => ({ ...prev, negative: "" }))}
                  placeholder="Add tags..."
                />
              </div>
              <label className="block text-sm md:col-span-1">
                <span className="text-slate-200">Notes</span>
                <textarea
                  value={form.notes}
                  onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
                  rows={6}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  placeholder="構図や出力時の注意点など"
                />
              </label>
            </div>

            <label className="block text-sm">
              <span className="text-slate-200">Variables (JSON)</span>
              <textarea
                value={form.variablesText}
                onChange={(event) => setForm((prev) => ({ ...prev, variablesText: event.target.value }))}
                rows={6}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-emerald-100 focus:border-emerald-400 focus:outline-none"
                placeholder='{"style":"neon","seed":1234}'
              />
            </label>

            <div className="flex justify-end gap-3">
              <button
                type="submit"
                disabled={saving}
                className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
              >
                {saving ? "保存中..." : isNew ? "作成" : "更新"}
              </button>
            </div>
          </>
        )}
      </form>

      {!isNew && recipe && (
        <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-white">このRecipeの履歴（runs）</h2>
              <p className="text-sm text-slate-400">実行状況は queued / running の間だけ自動更新します。</p>
            </div>
            <button
              type="button"
              onClick={() => fetchRecipeRuns()}
              className="rounded-md border border-emerald-400/60 px-3 py-2 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/10 disabled:opacity-50"
              disabled={runsPhase === "fetching"}
            >
              {runsPhase === "fetching" ? "更新中..." : "更新"}
            </button>
          </div>
          {runsError && <div className="text-sm text-red-200">Error: {runsError}</div>}
          {recipeRuns.length === 0 ? (
            <p className="text-sm text-slate-400">まだ実行履歴がありません。</p>
          ) : (
            <div className="rounded-lg border border-slate-800 bg-slate-950/50">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-900/60 text-slate-300">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Created</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                    <th className="px-3 py-2 font-semibold">CKPT / Size</th>
                    <th className="px-3 py-2 font-semibold">Prompt ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {recipeRuns.map((run) => {
                    const request = resolveRunRequest(run.request_json);
                    const ckpt = resolveRunCkpt(request);
                    const size = formatSize(resolveNumber(request.width), resolveNumber(request.height));
                    return (
                      <tr key={run.id} className="hover:bg-slate-800/40">
                        <td className="px-3 py-2 text-slate-200">{formatDate(run.created_at || run.updated_at)}</td>
                        <td className="px-3 py-2 text-slate-200">{formatRunStatus(run.status)}</td>
                        <td className="px-3 py-2 text-slate-200">
                          <div>{ckpt || "-"}</div>
                          <div className="text-xs text-slate-400">{size}</div>
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-300">{run.prompt_id || "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {!isNew && recipe && (
        <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-white">結果（gallery）</h2>
              <p className="text-sm text-slate-400">Recipeに紐づいた直近の生成結果を表示します。</p>
            </div>
            <button
              type="button"
              onClick={() => fetchRecipeGallery()}
              className="rounded-md border border-emerald-400/60 px-3 py-2 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/10 disabled:opacity-50"
              disabled={galleryPhase === "fetching"}
            >
              {galleryPhase === "fetching" ? "更新中..." : "更新"}
            </button>
          </div>
          {galleryError && <div className="text-sm text-red-200">Error: {galleryError}</div>}
          {galleryItems.length === 0 ? (
            <p className="text-sm text-slate-400">該当するギャラリー結果がまだありません。</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {galleryItems.map((item) => {
                const viewUrl = resolveGalleryViewUrl(item);
                return (
                  <a
                    key={item.id}
                    href={viewUrl || "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="group rounded-lg border border-slate-800 bg-slate-950/60 p-3 hover:border-emerald-400/40"
                  >
                    <div className="aspect-square w-full overflow-hidden rounded-md bg-slate-900">
                      {viewUrl ? (
                        <img
                          src={viewUrl}
                          alt={item.filename || "gallery"}
                          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xs text-slate-500">No image</div>
                      )}
                    </div>
                    <div className="mt-2 text-xs text-slate-400">{formatDate(item.created_at)}</div>
                  </a>
                );
              })}
            </div>
          )}
        </section>
      )}

      {!isNew && recipe && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">LoRA 紐づけ</h2>
                <p className="text-sm text-slate-400">LoRAを選択して weight / usage_notes を設定します。</p>
              </div>
            </div>
            <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
              <label className="block text-sm text-slate-200">
                <span className="text-xs uppercase tracking-wide text-slate-400">Search</span>
                <input
                  type="text"
                  value={filterText}
                  onChange={(event) => setFilterText(event.target.value)}
                  placeholder="Search LoRAs (name, trigger, tag)"
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  disabled={availableLoras.length === 0}
                />
              </label>
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>
                  {filteredLoras.length} results
                  {hasSelectedOutsideFilter ? " (+selected)" : ""}
                </span>
                {filteredLoras.length === 0 && availableLoras.length > 0 && !hasSelectedOutsideFilter && (
                  <span className="text-slate-300">
                    No matches.{" "}
                    <Link className="text-emerald-300 underline decoration-dotted" to="/workshop/loras/new">
                      LoRAを登録する
                    </Link>
                  </span>
                )}
              </div>
            </div>
            <form className="space-y-3" onSubmit={handleLinkLora}>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block text-sm">
                  <span className="text-slate-200">LoRA</span>
                  <select
                    value={linkForm.loraId}
                    onChange={(event) => setLinkForm((prev) => ({ ...prev, loraId: event.target.value }))}
                    disabled={availableLoras.length === 0}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none disabled:opacity-50"
                  >
                    <option value="">選択してください</option>
                    {displayLoras.map((lora) => (
                      <option key={lora.id} value={lora.id}>
                        {formatLoraLabel(lora)}
                      </option>
                    ))}
                  </select>
                  {availableLoras.length === 0 && (
                    <div className="mt-2 text-xs text-slate-400">
                      LoRAが未登録です。{" "}
                      <Link className="text-emerald-300 underline decoration-dotted" to="/workshop/loras/new">
                        LoRAを登録する
                      </Link>
                    </div>
                  )}
                </label>
                <div className="grid grid-cols-3 gap-3">
                  <label className="block text-sm">
                    <span className="text-slate-200">Weight</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={linkForm.weight}
                      onChange={(event) => setLinkForm((prev) => ({ ...prev, weight: event.target.value }))}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                      placeholder="0.7"
                    />
                  </label>
                  <label className="block text-sm col-span-2">
                    <span className="text-slate-200">Usage Notes</span>
                    <input
                      type="text"
                      value={linkForm.usageNotes}
                      onChange={(event) => setLinkForm((prev) => ({ ...prev, usageNotes: event.target.value }))}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                      placeholder="例: face only"
                    />
                  </label>
                </div>
                <label className="block text-sm">
                  <span className="text-slate-200">Sort Order</span>
                  <input
                    type="number"
                    value={linkForm.sortOrder}
                    onChange={(event) => setLinkForm((prev) => ({ ...prev, sortOrder: event.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
                  />
                </label>
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
                >
                  追加/更新
                </button>
              </div>
            </form>

            <div className="rounded-lg border border-slate-800 bg-slate-950/50">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-900/60 text-slate-300">
                  <tr>
                    <th className="px-3 py-2 font-semibold">LoRA</th>
                    <th className="px-3 py-2 font-semibold">Weight</th>
                    <th className="px-3 py-2 font-semibold">Usage</th>
                    <th className="px-3 py-2 font-semibold">Sort</th>
                    <th className="px-3 py-2 font-semibold text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {linkedLoras.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-center text-slate-300">
                        <div className="space-y-2">
                          <p>LoRAが未登録または未紐づけです。</p>
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
                    linkedLoras.map((item) => (
                      <tr key={item.lora_id} className="hover:bg-slate-800/40">
                        <td className="px-3 py-2 text-white">
                          <div className="font-semibold">{item.lora_name}</div>
                          {item.trigger_words?.length > 0 && (
                            <div className="text-xs text-slate-400">{item.trigger_words.join(", ")}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-200">{item.weight ?? "-"}</td>
                        <td className="px-3 py-2 text-slate-200">{item.usage_notes || "-"}</td>
                        <td className="px-3 py-2 text-slate-200">{item.sort_order}</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() =>
                              setLinkForm({
                                loraId: item.lora_id,
                                weight: item.weight !== null ? String(item.weight) : "",
                                usageNotes: item.usage_notes || "",
                                sortOrder: String(item.sort_order)
                              })
                            }
                            className="mr-3 text-xs text-emerald-300 underline decoration-dotted"
                          >
                            編集
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveLora(item.lora_id)}
                            className="text-xs text-red-200 underline decoration-dotted"
                          >
                            削除
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">Export</h2>
                <p className="text-sm text-slate-400">LoRAとプロンプトをまとめてコピーできます。</p>
              </div>
              <button
                type="button"
                onClick={copyExport}
                disabled={!exportText}
                className="rounded-md border border-emerald-400/60 px-3 py-2 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/10 disabled:opacity-50"
              >
                Copy
              </button>
            </div>
            <pre className="max-h-96 overflow-auto rounded-lg border border-slate-800 bg-slate-950/70 p-4 text-xs text-slate-100">
              {exportText || "まだエクスポートできる内容がありません。"}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}

function extractError(err: unknown) {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Recipeの操作に失敗しました。";
}

function formatLoraLabel(lora: Lora) {
  const triggers = (lora.trigger_words || []).filter(Boolean).map((v) => v.trim());
  const triggerText = triggers.length ? ` — triggers: ${truncateList(triggers, 3)}` : "";
  return `${lora.name}${triggerText}`;
}

function truncateList(items: string[], max: number) {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} (+${items.length - max})`;
}

function resolveRunRequest(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function resolveNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function resolveRunCkpt(request: Record<string, unknown>): string | null {
  const candidates = [request.ckptName, request.ckpt_name, request.checkpoint, request.checkpointName];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function formatSize(width?: number | null, height?: number | null) {
  if (width && height) return `${width}x${height}`;
  return "-";
}

function formatRunStatus(status?: string | null) {
  if (!status) return "-";
  return status;
}

function isRunActive(status?: string | null) {
  return status === "created" || status === "queued" || status === "running";
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString();
}

function resolveGalleryViewUrl(item: GalleryItem) {
  if (!item.viewUrl) return null;
  return `${API_BASE_URL}${item.viewUrl}`;
}
