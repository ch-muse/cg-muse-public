import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Link } from "react-router-dom";
import { api, ApiClientError, API_BASE_URL } from "../lib/api.js";
import PromptTextarea from "../components/prompt/PromptTextarea.js";
import type { GalleryItem } from "../types.js";

type FilterState = {
  ckpt: string;
  lora: string;
  w: string;
  h: string;
  dateFrom: string;
  dateTo: string;
  q: string;
  favoritesOnly: boolean;
};

type ManualEditState = {
  ckpt: string | null;
  loras: string | null;
  positive: string | null;
  negative: string | null;
  width: string | null;
  height: string | null;
  tags: string | null;
  notes: string | null;
};

type LoadPhase = "idle" | "loading" | "loading-more" | "error";

const PAGE_SIZE = 60;
const FETCH_TIMEOUT_MS = 8000;
const EDIT_TIMEOUT_MS = 8000;

const defaultFilters: FilterState = {
  ckpt: "",
  lora: "",
  w: "",
  h: "",
  dateFrom: "",
  dateTo: "",
  q: "",
  favoritesOnly: false
};

const formatDate = (value?: string | null) => {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
};

const formatSize = (width?: number | null, height?: number | null) => {
  if (typeof width === "number" && Number.isFinite(width) && typeof height === "number" && Number.isFinite(height)) {
    return `${width} x ${height}`;
  }
  return "-";
};

const truncateText = (value?: string | null, limit = 140) => {
  if (!value) return "-";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
};

const parseCommaInput = (value: string | null) => {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const parseNullableNumber = (value: string | null) => {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
};

const areArraysEqual = (a?: string[] | null, b?: string[] | null) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const resolveViewUrl = (item: GalleryItem) => {
  if (item.source_type === "folder") {
    return `${API_BASE_URL}/api/gallery/items/${item.id}/file`;
  }
  if (item.viewUrl) {
    return item.viewUrl.startsWith("http") ? item.viewUrl : `${API_BASE_URL}${item.viewUrl}`;
  }
  const params = new URLSearchParams({ filename: item.filename });
  if (item.subfolder) params.set("subfolder", item.subfolder);
  if (item.file_type) params.set("type", item.file_type);
  return `${API_BASE_URL}/api/comfy/view?${params.toString()}`;
};

const canRehydrate = (item: GalleryItem) => {
  if (item.source_type === "folder") return true;
  return Boolean(item.comfy_run_id);
};

const buildRehydrateUrl = (item: GalleryItem) => {
  const params = new URLSearchParams();
  if (item.comfy_run_id) {
    params.set("rehydrateRunId", item.comfy_run_id);
  }
  params.set("rehydrateGalleryItemId", item.id);
  return `/play/comfy?${params.toString()}`;
};

const parseOptionalNumber = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
};

const buildInitialEditForm = (item: GalleryItem): ManualEditState => ({
  ckpt: item.manual_ckpt_name ?? item.ckpt_name ?? null,
  loras: item.manual_lora_names
    ? item.manual_lora_names.join(", ")
    : item.lora_names
      ? item.lora_names.join(", ")
      : null,
  positive: item.manual_positive ?? item.positive ?? null,
  negative: item.manual_negative ?? item.negative ?? null,
  width:
    item.manual_width !== null && item.manual_width !== undefined
      ? String(item.manual_width)
      : item.width !== null && item.width !== undefined
        ? String(item.width)
        : null,
  height:
    item.manual_height !== null && item.manual_height !== undefined
      ? String(item.manual_height)
      : item.height !== null && item.height !== undefined
        ? String(item.height)
        : null,
  tags: item.manual_tags ? item.manual_tags.join(", ") : null,
  notes: item.manual_notes ?? null
});

export default function GalleryPage() {
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [appliedFilters, setAppliedFilters] = useState<FilterState>(defaultFilters);
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [imageSizes, setImageSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<LoadPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GalleryItem | null>(null);
  const [editForm, setEditForm] = useState<ManualEditState | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [extractBusy, setExtractBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState<Set<string>>(new Set());
  const activeRef = useRef(true);
  const requestIdRef = useRef(0);
  const inFlightRef = useRef<AbortController | null>(null);
  const editAbortRef = useRef<AbortController | null>(null);
  const editRequestIdRef = useRef(0);
  const editInFlightRef = useRef(false);
  const extractAbortRef = useRef<AbortController | null>(null);
  const extractRequestIdRef = useRef(0);
  const extractInFlightRef = useRef(false);
  const deleteAbortRef = useRef<AbortController | null>(null);
  const deleteRequestIdRef = useRef(0);
  const deleteInFlightRef = useRef(false);

  const appliedKey = useMemo(() => JSON.stringify(appliedFilters), [appliedFilters]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (inFlightRef.current) {
        inFlightRef.current.abort();
      }
      if (editAbortRef.current) {
        editAbortRef.current.abort();
      }
      if (extractAbortRef.current) {
        extractAbortRef.current.abort();
      }
      if (deleteAbortRef.current) {
        deleteAbortRef.current.abort();
      }
    };
  }, []);

  const fetchItems = useCallback(
    async (mode: "reset" | "append", cursor?: string | null) => {
      if (mode === "append" && !cursor) return;
      if (inFlightRef.current) {
        inFlightRef.current.abort();
      }

      const widthValue = parseOptionalNumber(appliedFilters.w);
      if (widthValue === null) {
        setError("width は数値で入力してください。");
        return;
      }
      const heightValue = parseOptionalNumber(appliedFilters.h);
      if (heightValue === null) {
        setError("height は数値で入力してください。");
        return;
      }

      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const controller = new AbortController();
      inFlightRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      setError(null);
      setPhase(mode === "append" ? "loading-more" : "loading");

      try {
        const data = await api.fetchGalleryItems(
          {
            limit: PAGE_SIZE,
            cursor: mode === "append" ? cursor ?? undefined : undefined,
            ckpt: appliedFilters.ckpt.trim() || undefined,
            lora: appliedFilters.lora.trim() || undefined,
            w: widthValue ?? undefined,
            h: heightValue ?? undefined,
            dateFrom: appliedFilters.dateFrom || undefined,
            dateTo: appliedFilters.dateTo || undefined,
            q: appliedFilters.q.trim() || undefined,
            favorited: appliedFilters.favoritesOnly ? true : undefined
          },
          { signal: controller.signal }
        );

        if (!activeRef.current || requestId !== requestIdRef.current) return;
        setItems((prev) => (mode === "append" ? [...prev, ...data.items] : data.items));
        setNextCursor(data.nextCursor ?? null);
        setPhase("idle");
      } catch (err) {
        if (!activeRef.current || requestId !== requestIdRef.current) return;
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        if (!isAbort) {
          setError(extractError(err));
        }
        setPhase("error");
      } finally {
        clearTimeout(timeoutId);
        if (inFlightRef.current === controller) {
          inFlightRef.current = null;
        }
      }
    },
    [appliedFilters]
  );

  useEffect(() => {
    fetchItems("reset");
  }, [appliedKey, fetchItems]);

  useEffect(() => {
    if (!selected) {
      setEditForm(null);
      setEditError(null);
      setEditMessage(null);
      setEditBusy(false);
      setExtractBusy(false);
      setDeleteBusy(false);
      return;
    }
    setEditForm(buildInitialEditForm(selected));
    setEditError(null);
    setEditMessage(null);
  }, [selected?.id]);

  const applyFilters = () => {
    setAppliedFilters(filters);
  };

  const resetFilters = () => {
    setFilters(defaultFilters);
    setAppliedFilters(defaultFilters);
  };

  const handleLoadMore = () => {
    fetchItems("append", nextCursor);
  };

  const handleImageLoad = useCallback(
    (itemId: string) => (event: SyntheticEvent<HTMLImageElement>) => {
      const { naturalWidth, naturalHeight } = event.currentTarget;
      if (!naturalWidth || !naturalHeight) return;
      setImageSizes((prev) => {
        const existing = prev[itemId];
        if (existing && existing.width === naturalWidth && existing.height === naturalHeight) {
          return prev;
        }
        return { ...prev, [itemId]: { width: naturalWidth, height: naturalHeight } };
      });
    },
    []
  );

  const applyItemUpdate = useCallback((item: GalleryItem) => {
    setItems((prev) => prev.map((entry) => (entry.id === item.id ? item : entry)));
    setSelected((prev) => (prev && prev.id === item.id ? item : prev));
  }, []);

  const handleToggleFavorite = async (item: GalleryItem) => {
    if (favoriteBusy.has(item.id)) return;
    setFavoriteBusy((prev) => new Set(prev).add(item.id));
    try {
      const result = await api.toggleGalleryFavorite(item.id);
      if (!activeRef.current) return;
      setItems((prev) => {
        const updated = prev.map((entry) => (entry.id === item.id ? result.item : entry));
        if (appliedFilters.favoritesOnly && !result.item.favorited) {
          return updated.filter((entry) => entry.id !== item.id);
        }
        return updated;
      });
      setSelected((prev) => (prev && prev.id === item.id ? result.item : prev));
    } catch (err) {
      if (activeRef.current) {
        setError(extractError(err));
      }
    } finally {
      setFavoriteBusy((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const handleResetField = (field: keyof ManualEditState) => {
    setEditForm((prev) => (prev ? { ...prev, [field]: null } : prev));
  };

  const handleResetAll = () => {
    setEditForm((prev) =>
      prev
        ? {
            ckpt: null,
            loras: null,
            positive: null,
            negative: null,
            width: null,
            height: null,
            tags: null,
            notes: null
          }
        : prev
    );
  };

  const handleSaveManual = async () => {
    if (!selected || !editForm) return;
    if (editInFlightRef.current) return;

    const widthValue = parseNullableNumber(editForm.width);
    if (widthValue === undefined) {
      setEditError("width は数値で入力してください。");
      return;
    }
    const heightValue = parseNullableNumber(editForm.height);
    if (heightValue === undefined) {
      setEditError("height は数値で入力してください。");
      return;
    }

    const nextLoras = parseCommaInput(editForm.loras);
    const nextTags = parseCommaInput(editForm.tags);

    let nextManualCkptName = editForm.ckpt === null ? null : editForm.ckpt.trim();
    let nextManualPositive = editForm.positive === null ? null : editForm.positive;
    let nextManualNegative = editForm.negative === null ? null : editForm.negative;
    let nextManualLoraNames = nextLoras;
    let nextManualTags = nextTags;
    let nextManualWidth = widthValue;
    let nextManualHeight = heightValue;
    let nextManualNotes = editForm.notes === null ? null : editForm.notes;

    if (selected.manual_ckpt_name == null && nextManualCkptName === (selected.ckpt_name ?? null)) {
      nextManualCkptName = null;
    }
    if (selected.manual_positive == null && nextManualPositive === (selected.positive ?? null)) {
      nextManualPositive = null;
    }
    if (selected.manual_negative == null && nextManualNegative === (selected.negative ?? null)) {
      nextManualNegative = null;
    }
    if (selected.manual_lora_names == null && areArraysEqual(nextManualLoraNames, selected.lora_names ?? null)) {
      nextManualLoraNames = null;
    }
    if (selected.manual_width == null && nextManualWidth === (selected.width ?? null)) {
      nextManualWidth = null;
    }
    if (selected.manual_height == null && nextManualHeight === (selected.height ?? null)) {
      nextManualHeight = null;
    }

    const nextManual = {
      manualCkptName: nextManualCkptName,
      manualPositive: nextManualPositive,
      manualNegative: nextManualNegative,
      manualLoraNames: nextManualLoraNames,
      manualTags: nextManualTags,
      manualWidth: nextManualWidth,
      manualHeight: nextManualHeight,
      manualNotes: nextManualNotes
    };

    const payload: Record<string, unknown> = {};
    if (nextManual.manualCkptName !== (selected.manual_ckpt_name ?? null)) {
      payload.manualCkptName = nextManual.manualCkptName;
    }
    if (nextManual.manualPositive !== (selected.manual_positive ?? null)) {
      payload.manualPositive = nextManual.manualPositive;
    }
    if (nextManual.manualNegative !== (selected.manual_negative ?? null)) {
      payload.manualNegative = nextManual.manualNegative;
    }
    if (!areArraysEqual(nextManual.manualLoraNames, selected.manual_lora_names ?? null)) {
      payload.manualLoraNames = nextManual.manualLoraNames;
    }
    if (!areArraysEqual(nextManual.manualTags, selected.manual_tags ?? null)) {
      payload.manualTags = nextManual.manualTags;
    }
    if (nextManual.manualWidth !== (selected.manual_width ?? null)) {
      payload.manualWidth = nextManual.manualWidth;
    }
    if (nextManual.manualHeight !== (selected.manual_height ?? null)) {
      payload.manualHeight = nextManual.manualHeight;
    }
    if (nextManual.manualNotes !== (selected.manual_notes ?? null)) {
      payload.manualNotes = nextManual.manualNotes;
    }

    if (Object.keys(payload).length === 0) {
      setEditMessage("変更がありません。");
      setEditError(null);
      return;
    }

    if (editAbortRef.current) {
      editAbortRef.current.abort();
    }
    const requestId = editRequestIdRef.current + 1;
    editRequestIdRef.current = requestId;
    const controller = new AbortController();
    editAbortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), EDIT_TIMEOUT_MS);

    editInFlightRef.current = true;
    setEditError(null);
    setEditMessage(null);
    setEditBusy(true);

    try {
      const result = await api.updateGalleryItem(selected.id, payload, { signal: controller.signal });
      if (!activeRef.current || requestId !== editRequestIdRef.current) return;
      applyItemUpdate(result.item);
      setEditForm(buildInitialEditForm(result.item));
      setEditMessage("保存しました。");
    } catch (err) {
      if (!activeRef.current || requestId !== editRequestIdRef.current) return;
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      if (!isAbort) {
        setEditError(extractError(err));
      }
    } finally {
      clearTimeout(timeoutId);
      editInFlightRef.current = false;
      setEditBusy(false);
      if (editAbortRef.current === controller) {
        editAbortRef.current = null;
      }
    }
  };

  const handleExtractMetadata = async () => {
    if (!selected) return;
    if (extractInFlightRef.current) return;
    if (selected.source_type !== "folder") {
      setEditError("フォルダ取り込みのアイテムのみ再抽出できます。");
      return;
    }

    if (extractAbortRef.current) {
      extractAbortRef.current.abort();
    }
    const requestId = extractRequestIdRef.current + 1;
    extractRequestIdRef.current = requestId;
    const controller = new AbortController();
    extractAbortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), EDIT_TIMEOUT_MS);

    extractInFlightRef.current = true;
    setEditError(null);
    setEditMessage(null);
    setExtractBusy(true);

    try {
      const result = await api.extractGalleryItem(selected.id, { signal: controller.signal });
      if (!activeRef.current || requestId !== extractRequestIdRef.current) return;
      applyItemUpdate(result.item);
      setEditMessage("再抽出しました。");
    } catch (err) {
      if (!activeRef.current || requestId !== extractRequestIdRef.current) return;
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      if (!isAbort) {
        setEditError(extractError(err));
      }
    } finally {
      clearTimeout(timeoutId);
      extractInFlightRef.current = false;
      setExtractBusy(false);
      if (extractAbortRef.current === controller) {
        extractAbortRef.current = null;
      }
    }
  };

  const handleDeleteItem = async () => {
    if (!selected) return;
    if (deleteInFlightRef.current) return;
    if (!window.confirm(`ギャラリーから削除しますか？: ${selected.filename}`)) return;

    if (deleteAbortRef.current) {
      deleteAbortRef.current.abort();
    }
    const requestId = deleteRequestIdRef.current + 1;
    deleteRequestIdRef.current = requestId;
    const controller = new AbortController();
    deleteAbortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), EDIT_TIMEOUT_MS);

    deleteInFlightRef.current = true;
    setEditError(null);
    setEditMessage(null);
    setDeleteBusy(true);

    try {
      await api.deleteGalleryItem(selected.id, { signal: controller.signal });
      if (!activeRef.current || requestId !== deleteRequestIdRef.current) return;
      setItems((prev) => prev.filter((entry) => entry.id !== selected.id));
      setSelected(null);
    } catch (err) {
      if (!activeRef.current || requestId !== deleteRequestIdRef.current) return;
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      if (!isAbort) {
        setEditError(extractError(err));
      }
    } finally {
      clearTimeout(timeoutId);
      deleteInFlightRef.current = false;
      setDeleteBusy(false);
      if (deleteAbortRef.current === controller) {
        deleteAbortRef.current = null;
      }
    }
  };

  const isLoading = phase === "loading";
  const isLoadingMore = phase === "loading-more";
  const selectedImageSize = selected ? imageSizes[selected.id] : null;
  const selectedMetaExtracted =
    selected && selected.meta_extracted && typeof selected.meta_extracted === "object"
      ? (selected.meta_extracted as Record<string, unknown>)
      : null;
  const extractedSource =
    selectedMetaExtracted && typeof selectedMetaExtracted.source === "string" ? selectedMetaExtracted.source : null;
  const extractedErrors = Array.isArray(selectedMetaExtracted?.parseErrors) ? selectedMetaExtracted?.parseErrors : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Library</p>
          <h1 className="text-3xl font-semibold">Gallery</h1>
          <p className="text-sm text-slate-400">生成成果物を横断して検索・再利用します。</p>
        </div>
        <button
          type="button"
          onClick={() => fetchItems("reset")}
          className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
        >
          再読み込み
        </button>
      </div>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 shadow-lg shadow-black/40">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Filters</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={resetFilters}
              className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-slate-400 hover:text-white"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={applyFilters}
              className="rounded-md border border-emerald-500/60 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-100 transition hover:border-emerald-400 hover:bg-emerald-500/20"
            >
              Apply
            </button>
          </div>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-[0.2em] text-slate-400">Checkpoint</label>
            <input
              type="text"
              value={filters.ckpt}
              onChange={(event) => setFilters((prev) => ({ ...prev, ckpt: event.target.value }))}
              placeholder="ckpt name"
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-[0.2em] text-slate-400">LoRA</label>
            <input
              type="text"
              value={filters.lora}
              onChange={(event) => setFilters((prev) => ({ ...prev, lora: event.target.value }))}
              placeholder="lora name"
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-[0.2em] text-slate-400">Prompt Search</label>
            <input
              type="text"
              value={filters.q}
              onChange={(event) => setFilters((prev) => ({ ...prev, q: event.target.value }))}
              placeholder="prompt keywords"
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-[0.2em] text-slate-400">Width</label>
            <input
              type="number"
              value={filters.w}
              onChange={(event) => setFilters((prev) => ({ ...prev, w: event.target.value }))}
              placeholder="例: 1216"
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-[0.2em] text-slate-400">Height</label>
            <input
              type="number"
              value={filters.h}
              onChange={(event) => setFilters((prev) => ({ ...prev, h: event.target.value }))}
              placeholder="例: 1728"
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-[0.2em] text-slate-400">Date From</label>
            <input
              type="date"
              value={filters.dateFrom}
              onChange={(event) => setFilters((prev) => ({ ...prev, dateFrom: event.target.value }))}
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-[0.2em] text-slate-400">Date To</label>
            <input
              type="date"
              value={filters.dateTo}
              onChange={(event) => setFilters((prev) => ({ ...prev, dateTo: event.target.value }))}
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2 pt-6">
            <input
              id="favorites-only"
              type="checkbox"
              checked={filters.favoritesOnly}
              onChange={(event) => setFilters((prev) => ({ ...prev, favoritesOnly: event.target.checked }))}
              className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-emerald-400 focus:ring-emerald-400"
            />
            <label htmlFor="favorites-only" className="text-sm text-slate-300">
              Favorites only
            </label>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      <section className="space-y-4">
        {isLoading ? (
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-6 text-sm text-slate-400">
            読み込み中...
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-6 text-sm text-slate-400">
            ギャラリーにアイテムがありません。
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => {
              const viewUrl = resolveViewUrl(item);
              const imageSize = imageSizes[item.id];
              const sizeText = formatSize(imageSize?.width ?? item.width, imageSize?.height ?? item.height);
              const busy = favoriteBusy.has(item.id);
              return (
                <div key={item.id} className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/60 shadow-lg shadow-black/30">
                  <div className="relative">
                    {viewUrl ? (
                      <img
                        src={viewUrl}
                        alt={item.filename}
                        loading="lazy"
                        decoding="async"
                        onLoad={handleImageLoad(item.id)}
                        className="h-48 w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-48 items-center justify-center text-xs text-slate-500">No image</div>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleToggleFavorite(item);
                      }}
                      className={`absolute right-2 top-2 rounded-full border px-3 py-1 text-xs transition ${
                        item.favorited
                          ? "border-amber-400/70 bg-amber-400/20 text-amber-100"
                          : "border-slate-700 bg-slate-900/70 text-slate-200 hover:border-amber-300/70"
                      }`}
                    >
                      {item.favorited ? "Favorited" : "Favorite"}
                    </button>
                  </div>
                  <div className="space-y-2 px-4 py-3">
                    <div className="text-xs text-slate-400">{formatDate(item.created_at)}</div>
                    <div className="text-sm text-slate-100">{item.ckpt_name || "-"}</div>
                    <div className="text-xs text-slate-400">Size: {sizeText}</div>
                    {item.lora_names && item.lora_names.length > 0 && (
                      <div className="text-xs text-slate-500">LoRA: {item.lora_names.join(", ")}</div>
                    )}
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => setSelected(item)}
                        className="text-emerald-300 hover:text-emerald-200"
                      >
                        Details
                      </button>
                      {canRehydrate(item) && (
                        <Link to={buildRehydrateUrl(item)} className="text-slate-300 hover:text-white">
                          Rehydrate
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {nextCursor && (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={isLoadingMore}
              className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-emerald-400/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoadingMore ? "Loading..." : "Load more"}
            </button>
          </div>
        )}
      </section>

      <Dialog.Root
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        {selected && (
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/80" />
            <div className="fixed inset-0 z-50 flex items-center justify-center px-6 py-10">
              <Dialog.Content className="max-h-full w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 focus:outline-none">
                <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Gallery Item</p>
                    <Dialog.Title asChild>
                      <h2 className="text-lg font-semibold text-slate-100">{selected.ckpt_name || "Untitled"}</h2>
                    </Dialog.Title>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:border-slate-400"
                    >
                      Close
                    </button>
                  </Dialog.Close>
                </div>
                <div className="grid gap-4 p-5 md:grid-cols-[2fr_1fr]">
                  <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                    <img
                      src={resolveViewUrl(selected)}
                      alt={selected.filename}
                      onLoad={handleImageLoad(selected.id)}
                      className="max-h-[70vh] w-full object-contain"
                    />
                  </div>
                  <div className="space-y-4 text-sm text-slate-200 md:max-h-[70vh] md:overflow-y-auto md:pr-2">
                    <div className="space-y-1">
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Meta</div>
                      <div>Created: {formatDate(selected.created_at)}</div>
                      <div>
                        Size: {formatSize(selectedImageSize?.width ?? selected.width, selectedImageSize?.height ?? selected.height)}
                      </div>
                      <div>Prompt ID: {selected.prompt_id || "-"}</div>
                      {selected.source_type === "folder" && <div>Path: {selected.rel_path ?? "-"}</div>}
                      {selected.lora_names && selected.lora_names.length > 0 && (
                        <div>LoRA: {selected.lora_names.join(", ")}</div>
                      )}
                      {selected.needs_review && <div className="text-amber-300">Needs review</div>}
                    </div>

                    <div className="space-y-1">
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Extracted</div>
                      <div>Source: {extractedSource ?? "-"}</div>
                      {extractedErrors.length > 0 && (
                        <div className="text-xs text-rose-200">Parse errors: {extractedErrors.join(", ")}</div>
                      )}
                      <div className="text-xs text-slate-400">
                        CKPT: {selected.extracted_ckpt_name ?? "-"}
                      </div>
                      <div className="text-xs text-slate-400">
                        Size: {formatSize(selected.extracted_width, selected.extracted_height)}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Prompt (Effective)</div>
                      <div className="text-xs text-slate-300">Positive: {truncateText(selected.positive)}</div>
                      <div className="text-xs text-slate-300">Negative: {truncateText(selected.negative)}</div>
                    </div>

                    {editForm ? (
                  <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                    <div className="flex items-center justify-between">
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Manual Overrides</div>
                      <button
                        type="button"
                        onClick={handleResetAll}
                        className="text-xs text-slate-400 hover:text-slate-200"
                      >
                        Reset all
                      </button>
                    </div>
                    <div className="mt-3 space-y-3">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-500">
                          <span>Checkpoint</span>
                          <button
                            type="button"
                            onClick={() => handleResetField("ckpt")}
                            className="text-[11px] text-slate-400 hover:text-slate-200"
                          >
                            Reset
                          </button>
                        </div>
                        <input
                          value={editForm.ckpt ?? ""}
                          onChange={(event) =>
                            setEditForm((prev) => (prev ? { ...prev, ckpt: event.target.value } : prev))
                          }
                          placeholder={selected.extracted_ckpt_name ?? ""}
                          className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
                        />
                        <div className="text-[11px] text-slate-500">
                          Extracted: {selected.extracted_ckpt_name ?? "-"}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-500">
                          <span>LoRA (comma)</span>
                          <button
                            type="button"
                            onClick={() => handleResetField("loras")}
                            className="text-[11px] text-slate-400 hover:text-slate-200"
                          >
                            Reset
                          </button>
                        </div>
                        <input
                          value={editForm.loras ?? ""}
                          onChange={(event) =>
                            setEditForm((prev) => (prev ? { ...prev, loras: event.target.value } : prev))
                          }
                          placeholder={selected.extracted_lora_names?.join(", ") ?? ""}
                          className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
                        />
                        <div className="text-[11px] text-slate-500">
                          Extracted: {selected.extracted_lora_names?.join(", ") || "-"}
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-500">
                            <span>Width</span>
                            <button
                              type="button"
                              onClick={() => handleResetField("width")}
                              className="text-[11px] text-slate-400 hover:text-slate-200"
                            >
                              Reset
                            </button>
                          </div>
                          <input
                            value={editForm.width ?? ""}
                            onChange={(event) =>
                              setEditForm((prev) => (prev ? { ...prev, width: event.target.value } : prev))
                            }
                            placeholder={selected.extracted_width?.toString() ?? ""}
                            className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
                          />
                        </div>
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-500">
                            <span>Height</span>
                            <button
                              type="button"
                              onClick={() => handleResetField("height")}
                              className="text-[11px] text-slate-400 hover:text-slate-200"
                            >
                              Reset
                            </button>
                          </div>
                          <input
                            value={editForm.height ?? ""}
                            onChange={(event) =>
                              setEditForm((prev) => (prev ? { ...prev, height: event.target.value } : prev))
                            }
                            placeholder={selected.extracted_height?.toString() ?? ""}
                            className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
                          />
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-500">
                          <span>Positive</span>
                          <button
                            type="button"
                            onClick={() => handleResetField("positive")}
                            className="text-[11px] text-slate-400 hover:text-slate-200"
                          >
                            Reset
                          </button>
                        </div>
                        <PromptTextarea
                          value={editForm.positive ?? ""}
                          onChange={(value) => setEditForm((prev) => (prev ? { ...prev, positive: value } : prev))}
                          placeholder={selected.extracted_positive ?? ""}
                          rows={3}
                          className="w-full resize-none rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
                        />
                        <div className="text-[11px] text-slate-500">
                          Extracted: {truncateText(selected.extracted_positive, 120)}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-500">
                          <span>Negative</span>
                          <button
                            type="button"
                            onClick={() => handleResetField("negative")}
                            className="text-[11px] text-slate-400 hover:text-slate-200"
                          >
                            Reset
                          </button>
                        </div>
                        <PromptTextarea
                          value={editForm.negative ?? ""}
                          onChange={(value) => setEditForm((prev) => (prev ? { ...prev, negative: value } : prev))}
                          placeholder={selected.extracted_negative ?? ""}
                          rows={3}
                          className="w-full resize-none rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
                        />
                        <div className="text-[11px] text-slate-500">
                          Extracted: {truncateText(selected.extracted_negative, 120)}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-500">
                          <span>Tags</span>
                          <button
                            type="button"
                            onClick={() => handleResetField("tags")}
                            className="text-[11px] text-slate-400 hover:text-slate-200"
                          >
                            Reset
                          </button>
                        </div>
                        <input
                          value={editForm.tags ?? ""}
                          onChange={(event) =>
                            setEditForm((prev) => (prev ? { ...prev, tags: event.target.value } : prev))
                          }
                          placeholder="optional tags"
                          className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
                        />
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-500">
                          <span>Notes</span>
                          <button
                            type="button"
                            onClick={() => handleResetField("notes")}
                            className="text-[11px] text-slate-400 hover:text-slate-200"
                          >
                            Reset
                          </button>
                        </div>
                        <textarea
                          value={editForm.notes ?? ""}
                          onChange={(event) =>
                            setEditForm((prev) => (prev ? { ...prev, notes: event.target.value } : prev))
                          }
                          placeholder="memo"
                          rows={3}
                          className="w-full resize-none rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-500">
                    編集データを読み込み中...
                  </div>
                )}

                {editError && (
                  <div className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
                    {editError}
                  </div>
                )}
                {editMessage && <div className="text-xs text-slate-400">{editMessage}</div>}

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleSaveManual}
                    disabled={editBusy}
                    className="rounded-md border border-emerald-500/60 px-3 py-1 text-xs text-emerald-100 transition hover:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {editBusy ? "Saving..." : "Save overrides"}
                  </button>
                  <button
                    type="button"
                    onClick={handleExtractMetadata}
                    disabled={extractBusy || selected.source_type !== "folder"}
                    className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {extractBusy ? "Extracting..." : "Re-extract"}
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteItem}
                    disabled={deleteBusy}
                    className="rounded-md border border-rose-500/60 px-3 py-1 text-xs text-rose-200 transition hover:border-rose-300 hover:text-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {deleteBusy ? "Deleting..." : "Delete record"}
                  </button>
                </div>

                <div className="flex flex-wrap gap-2">
                  <a
                    href={resolveViewUrl(selected)}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-emerald-500/60 px-3 py-1 text-xs text-emerald-100 hover:border-emerald-400"
                  >
                    Open image
                  </a>
                  {canRehydrate(selected) && (
                    <Link
                      to={buildRehydrateUrl(selected)}
                      className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:border-slate-400"
                    >
                      Rehydrate to Comfy Runner
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={() => handleToggleFavorite(selected)}
                    className={`rounded-md border px-3 py-1 text-xs transition ${
                      selected.favorited
                        ? "border-amber-400/70 bg-amber-400/20 text-amber-100"
                        : "border-slate-700 text-slate-200 hover:border-amber-300/70"
                    }`}
                  >
                    {selected.favorited ? "Favorited" : "Favorite"}
                  </button>
                </div>
              </div>
            </div>
            </Dialog.Content>
            </div>
          </Dialog.Portal>
        )}
      </Dialog.Root>
    </div>
  );
}

function extractError(err: unknown) {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "ギャラリーの取得に失敗しました。";
}
