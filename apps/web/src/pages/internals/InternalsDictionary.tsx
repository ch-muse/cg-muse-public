import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { API_BASE_URL } from "../../lib/api.js";

const FETCH_TIMEOUT_MS = 12000;
const DEBUG_TEXT_LIMIT = 600;
const IMPORT_BATCH_SIZE = 500;

type TabKey = "dictionary" | "translations";

type DictionaryItem = {
  tag: string;
  type?: string | null;
  count?: number | null;
  aliases: string[];
  created_at?: string;
  updated_at?: string;
};

type TranslationItem = {
  tag: string;
  ja: string;
  source: string;
  seen_count?: number | null;
  created_at?: string;
  updated_at?: string;
};

type DebugState = {
  phase: "idle" | "fetching" | "success" | "error";
  lastUpdatedAt: string | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  lastRawText: string | null;
  lastRequestUrl: string | null;
};

type ImportState = {
  phase: "idle" | "uploading" | "success" | "error";
  total: number;
  sent: number;
  failed: number;
  lastError?: string | null;
  lastResultSummary?: string | null;
};

type DictionaryForm = {
  tag: string;
  type: string;
  count: string;
  aliases: string;
};

type TranslationForm = {
  tag: string;
  ja: string;
  source: string;
};

const emptyDebug: DebugState = {
  phase: "idle",
  lastUpdatedAt: null,
  lastHttpStatus: null,
  lastError: null,
  lastRawText: null,
  lastRequestUrl: null
};

const emptyImport: ImportState = {
  phase: "idle",
  total: 0,
  sent: 0,
  failed: 0,
  lastError: null,
  lastResultSummary: null
};

const truncateText = (text: string, limit = DEBUG_TEXT_LIMIT) =>
  text.length > limit ? `${text.slice(0, limit)}...` : text;

const parseAliases = (value: string) =>
  value
    .split(/[|,]/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const chunkArray = <T,>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const useDebouncedValue = (value: string, delay = 300) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [delay, value]);
  return debounced;
};

const formatTimestamp = (value: string | null) => {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
};
export default function InternalsDictionaryPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("dictionary");

  const [dictionaryItems, setDictionaryItems] = useState<DictionaryItem[]>([]);
  const [dictionaryTotal, setDictionaryTotal] = useState<number | null>(null);
  const [dictionaryLimit, setDictionaryLimit] = useState(50);
  const [dictionaryPage, setDictionaryPage] = useState(0);
  const [dictionarySearch, setDictionarySearch] = useState("");
  const dictionaryQuery = useDebouncedValue(dictionarySearch);

  const [translationItems, setTranslationItems] = useState<TranslationItem[]>([]);
  const [translationTotal, setTranslationTotal] = useState<number | null>(null);
  const [translationLimit, setTranslationLimit] = useState(50);
  const [translationPage, setTranslationPage] = useState(0);
  const [translationSearch, setTranslationSearch] = useState("");
  const translationQuery = useDebouncedValue(translationSearch);

  const [debugState, setDebugState] = useState<Record<TabKey, DebugState>>({
    dictionary: emptyDebug,
    translations: emptyDebug
  });
  const [messageState, setMessageState] = useState<Record<TabKey, string | null>>({
    dictionary: null,
    translations: null
  });
  const [importState, setImportState] = useState<Record<TabKey, ImportState>>({
    dictionary: emptyImport,
    translations: emptyImport
  });

  const [modalOpen, setModalOpen] = useState(false);
  const [modalTab, setModalTab] = useState<TabKey>("dictionary");
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [dictionaryForm, setDictionaryForm] = useState<DictionaryForm>({
    tag: "",
    type: "",
    count: "",
    aliases: ""
  });
  const [translationForm, setTranslationForm] = useState<TranslationForm>({
    tag: "",
    ja: "",
    source: "ollama"
  });
  const [dictionaryCsvFile, setDictionaryCsvFile] = useState<File | null>(null);

  const dictImportRef = useRef<HTMLInputElement | null>(null);
  const translationImportRef = useRef<HTMLInputElement | null>(null);

  const dictionaryListInFlightRef = useRef(false);
  const dictionaryListRequestIdRef = useRef(0);
  const dictionaryListAbortRef = useRef<AbortController | null>(null);

  const translationListInFlightRef = useRef(false);
  const translationListRequestIdRef = useRef(0);
  const translationListAbortRef = useRef<AbortController | null>(null);

  const dictionaryActionInFlightRef = useRef(false);
  const dictionaryActionRequestIdRef = useRef(0);
  const dictionaryActionAbortRef = useRef<AbortController | null>(null);

  const translationActionInFlightRef = useRef(false);
  const translationActionRequestIdRef = useRef(0);
  const translationActionAbortRef = useRef<AbortController | null>(null);

  const dictionaryImportInFlightRef = useRef(false);
  const dictionaryImportRequestIdRef = useRef(0);
  const dictionaryImportAbortRef = useRef<AbortController | null>(null);
  const translationImportInFlightRef = useRef(false);
  const translationImportRequestIdRef = useRef(0);
  useEffect(() => {
    setDictionaryPage(0);
  }, [dictionaryQuery, dictionaryLimit]);

  useEffect(() => {
    setTranslationPage(0);
  }, [translationQuery, translationLimit]);

  const fetchDictionaryPage = useCallback(async () => {
    if (dictionaryListAbortRef.current) {
      dictionaryListAbortRef.current.abort();
    }
    const requestId = dictionaryListRequestIdRef.current + 1;
    dictionaryListRequestIdRef.current = requestId;
    dictionaryListInFlightRef.current = true;
    const controller = new AbortController();
    dictionaryListAbortRef.current = controller;

    const params = new URLSearchParams();
    if (dictionaryQuery.trim()) params.set("q", dictionaryQuery.trim());
    params.set("limit", String(dictionaryLimit));
    params.set("offset", String(dictionaryPage * dictionaryLimit));
    const url = `${API_BASE_URL}/api/tags/dictionary?${params.toString()}`;

    setDebugState((prev) => ({
      ...prev,
      dictionary: {
        ...prev.dictionary,
        phase: "fetching",
        lastError: null,
        lastHttpStatus: null,
        lastRawText: null,
        lastRequestUrl: url
      }
    }));

    let rawText = "";
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      rawText = await response.text();
      if (dictionaryListRequestIdRef.current !== requestId) return;
      setDebugState((prev) => ({
        ...prev,
        dictionary: {
          ...prev.dictionary,
          lastHttpStatus: response.status,
          lastRawText: rawText ? truncateText(rawText) : null
        }
      }));
      if (!response.ok) {
        setDebugState((prev) => ({
          ...prev,
          dictionary: {
            ...prev.dictionary,
            phase: "error",
            lastError: `HTTP ${response.status}`
          }
        }));
        return;
      }
      let payload: any = null;
      try {
        payload = rawText ? JSON.parse(rawText) : null;
      } catch {
        setDebugState((prev) => ({
          ...prev,
          dictionary: {
            ...prev.dictionary,
            phase: "error",
            lastError: "Invalid response"
          }
        }));
        return;
      }
      if (!payload || payload.ok !== true || !payload.data || !Array.isArray(payload.data.items)) {
        setDebugState((prev) => ({
          ...prev,
          dictionary: {
            ...prev.dictionary,
            phase: "error",
            lastError: payload?.error?.message || "Invalid response"
          }
        }));
        return;
      }
      const items = payload.data.items as DictionaryItem[];
      const total = typeof payload.data.total === "number" ? payload.data.total : null;
      setDictionaryItems(items);
      setDictionaryTotal(total);
      setDebugState((prev) => ({
        ...prev,
        dictionary: {
          ...prev.dictionary,
          phase: "success",
          lastUpdatedAt: new Date().toISOString()
        }
      }));
    } catch (err) {
      if (dictionaryListRequestIdRef.current !== requestId) return;
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : err instanceof Error
            ? err.message
            : "fetch failed";
      setDebugState((prev) => ({
        ...prev,
        dictionary: {
          ...prev.dictionary,
          phase: "error",
          lastError: message
        }
      }));
    } finally {
      clearTimeout(timeoutId);
      if (dictionaryListRequestIdRef.current === requestId) {
        dictionaryListInFlightRef.current = false;
      }
    }
  }, [dictionaryLimit, dictionaryPage, dictionaryQuery]);

  const fetchTranslationPage = useCallback(async () => {
    if (translationListAbortRef.current) {
      translationListAbortRef.current.abort();
    }
    const requestId = translationListRequestIdRef.current + 1;
    translationListRequestIdRef.current = requestId;
    translationListInFlightRef.current = true;
    const controller = new AbortController();
    translationListAbortRef.current = controller;

    const params = new URLSearchParams();
    if (translationQuery.trim()) params.set("q", translationQuery.trim());
    params.set("limit", String(translationLimit));
    params.set("offset", String(translationPage * translationLimit));
    const url = `${API_BASE_URL}/api/tags/translations?${params.toString()}`;

    setDebugState((prev) => ({
      ...prev,
      translations: {
        ...prev.translations,
        phase: "fetching",
        lastError: null,
        lastHttpStatus: null,
        lastRawText: null,
        lastRequestUrl: url
      }
    }));

    let rawText = "";
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      rawText = await response.text();
      if (translationListRequestIdRef.current !== requestId) return;
      setDebugState((prev) => ({
        ...prev,
        translations: {
          ...prev.translations,
          lastHttpStatus: response.status,
          lastRawText: rawText ? truncateText(rawText) : null
        }
      }));
      if (!response.ok) {
        setDebugState((prev) => ({
          ...prev,
          translations: {
            ...prev.translations,
            phase: "error",
            lastError: `HTTP ${response.status}`
          }
        }));
        return;
      }
      let payload: any = null;
      try {
        payload = rawText ? JSON.parse(rawText) : null;
      } catch {
        setDebugState((prev) => ({
          ...prev,
          translations: {
            ...prev.translations,
            phase: "error",
            lastError: "Invalid response"
          }
        }));
        return;
      }
      if (!payload || payload.ok !== true || !payload.data || !Array.isArray(payload.data.items)) {
        setDebugState((prev) => ({
          ...prev,
          translations: {
            ...prev.translations,
            phase: "error",
            lastError: payload?.error?.message || "Invalid response"
          }
        }));
        return;
      }
      const items = payload.data.items as TranslationItem[];
      const total = typeof payload.data.total === "number" ? payload.data.total : null;
      setTranslationItems(items);
      setTranslationTotal(total);
      setDebugState((prev) => ({
        ...prev,
        translations: {
          ...prev.translations,
          phase: "success",
          lastUpdatedAt: new Date().toISOString()
        }
      }));
    } catch (err) {
      if (translationListRequestIdRef.current !== requestId) return;
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : err instanceof Error
            ? err.message
            : "fetch failed";
      setDebugState((prev) => ({
        ...prev,
        translations: {
          ...prev.translations,
          phase: "error",
          lastError: message
        }
      }));
    } finally {
      clearTimeout(timeoutId);
      if (translationListRequestIdRef.current === requestId) {
        translationListInFlightRef.current = false;
      }
    }
  }, [translationLimit, translationPage, translationQuery]);

  useEffect(() => {
    if (activeTab !== "dictionary") return;
    fetchDictionaryPage();
  }, [activeTab, fetchDictionaryPage]);

  useEffect(() => {
    if (activeTab !== "translations") return;
    fetchTranslationPage();
  }, [activeTab, fetchTranslationPage]);

  const dictionaryPageCount = dictionaryTotal ? Math.max(1, Math.ceil(dictionaryTotal / dictionaryLimit)) : null;
  const translationPageCount = translationTotal ? Math.max(1, Math.ceil(translationTotal / translationLimit)) : null;
  const dictionaryHasNext = dictionaryTotal
    ? (dictionaryPage + 1) * dictionaryLimit < dictionaryTotal
    : dictionaryItems.length === dictionaryLimit;
  const translationHasNext = translationTotal
    ? (translationPage + 1) * translationLimit < translationTotal
    : translationItems.length === translationLimit;
  const resetModal = () => {
    setModalOpen(false);
    setEditingTag(null);
    setDictionaryForm({ tag: "", type: "", count: "", aliases: "" });
    setTranslationForm({ tag: "", ja: "", source: "ollama" });
  };

  const openDictionaryModal = (entry?: DictionaryItem) => {
    setModalTab("dictionary");
    setEditingTag(entry ? entry.tag : null);
    setDictionaryForm({
      tag: entry?.tag ?? "",
      type: entry?.type ?? "",
      count: entry?.count !== undefined && entry?.count !== null ? String(entry.count) : "",
      aliases: entry?.aliases?.join(", ") ?? ""
    });
    setModalOpen(true);
  };

  const openTranslationModal = (entry?: TranslationItem) => {
    setModalTab("translations");
    setEditingTag(entry ? entry.tag : null);
    setTranslationForm({
      tag: entry?.tag ?? "",
      ja: entry?.ja ?? "",
      source: entry?.source ?? "ollama"
    });
    setModalOpen(true);
  };

  const handleSaveDictionary = useCallback(async () => {
    if (dictionaryActionInFlightRef.current) return;
    const tag = dictionaryForm.tag.trim();
    if (!tag) {
      setMessageState((prev) => ({ ...prev, dictionary: "tag is required" }));
      return;
    }
    const type = dictionaryForm.type.trim();
    const countValue = Number(dictionaryForm.count.trim());
    const count = Number.isFinite(countValue) ? Math.trunc(countValue) : undefined;
    const aliases = parseAliases(dictionaryForm.aliases);

    dictionaryActionInFlightRef.current = true;
    const requestId = dictionaryActionRequestIdRef.current + 1;
    dictionaryActionRequestIdRef.current = requestId;
    const controller = new AbortController();
    dictionaryActionAbortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE_URL}/api/tags/dictionary`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag,
          type: type.length > 0 ? type : undefined,
          count: count !== undefined ? count : undefined,
          aliases
        }),
        cache: "no-store",
        signal: controller.signal
      });
      const text = await response.text();
      if (dictionaryActionRequestIdRef.current !== requestId) return;
      if (!response.ok) {
        setMessageState((prev) => ({ ...prev, dictionary: `HTTP ${response.status}` }));
        return;
      }
      let payload: any = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        setMessageState((prev) => ({ ...prev, dictionary: "Invalid response" }));
        return;
      }
      if (!payload || payload.ok !== true) {
        setMessageState((prev) => ({ ...prev, dictionary: payload?.error?.message || "Save failed" }));
        return;
      }
      setMessageState((prev) => ({ ...prev, dictionary: "Saved" }));
      resetModal();
      fetchDictionaryPage();
    } catch (err) {
      if (dictionaryActionRequestIdRef.current !== requestId) return;
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : err instanceof Error
            ? err.message
            : "save failed";
      setMessageState((prev) => ({ ...prev, dictionary: message }));
    } finally {
      clearTimeout(timeoutId);
      if (dictionaryActionRequestIdRef.current === requestId) {
        dictionaryActionInFlightRef.current = false;
      }
    }
  }, [dictionaryForm, fetchDictionaryPage]);

  const handleSaveTranslation = useCallback(async () => {
    if (translationActionInFlightRef.current) return;
    const tag = translationForm.tag.trim();
    const ja = translationForm.ja.trim();
    if (!tag || !ja) {
      setMessageState((prev) => ({ ...prev, translations: "tag and ja are required" }));
      return;
    }
    const source = translationForm.source.trim();

    translationActionInFlightRef.current = true;
    const requestId = translationActionRequestIdRef.current + 1;
    translationActionRequestIdRef.current = requestId;
    const controller = new AbortController();
    translationActionAbortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE_URL}/api/tags/translations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag,
          ja,
          source: source.length > 0 ? source : undefined
        }),
        cache: "no-store",
        signal: controller.signal
      });
      const text = await response.text();
      if (translationActionRequestIdRef.current !== requestId) return;
      if (!response.ok) {
        setMessageState((prev) => ({ ...prev, translations: `HTTP ${response.status}` }));
        return;
      }
      let payload: any = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        setMessageState((prev) => ({ ...prev, translations: "Invalid response" }));
        return;
      }
      if (!payload || payload.ok !== true) {
        setMessageState((prev) => ({ ...prev, translations: payload?.error?.message || "Save failed" }));
        return;
      }
      setMessageState((prev) => ({ ...prev, translations: "Saved" }));
      resetModal();
      fetchTranslationPage();
    } catch (err) {
      if (translationActionRequestIdRef.current !== requestId) return;
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : err instanceof Error
            ? err.message
            : "save failed";
      setMessageState((prev) => ({ ...prev, translations: message }));
    } finally {
      clearTimeout(timeoutId);
      if (translationActionRequestIdRef.current === requestId) {
        translationActionInFlightRef.current = false;
      }
    }
  }, [fetchTranslationPage, translationForm]);

  const handleDeleteDictionary = useCallback(
    async (tag: string) => {
      if (dictionaryActionInFlightRef.current) return;
      if (!window.confirm(`Delete "${tag}"?`)) return;
      dictionaryActionInFlightRef.current = true;
      const requestId = dictionaryActionRequestIdRef.current + 1;
      dictionaryActionRequestIdRef.current = requestId;
      const controller = new AbortController();
      dictionaryActionAbortRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(`${API_BASE_URL}/api/tags/dictionary/${encodeURIComponent(tag)}`, {
          method: "DELETE",
          cache: "no-store",
          signal: controller.signal
        });
        const text = await response.text();
        if (dictionaryActionRequestIdRef.current !== requestId) return;
        if (!response.ok) {
          setMessageState((prev) => ({ ...prev, dictionary: `HTTP ${response.status}` }));
          return;
        }
        let payload: any = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          setMessageState((prev) => ({ ...prev, dictionary: "Invalid response" }));
          return;
        }
        if (!payload || payload.ok !== true) {
          setMessageState((prev) => ({ ...prev, dictionary: payload?.error?.message || "Delete failed" }));
          return;
        }
        setMessageState((prev) => ({ ...prev, dictionary: "Deleted" }));
        fetchDictionaryPage();
      } catch (err) {
        if (dictionaryActionRequestIdRef.current !== requestId) return;
        const message =
          err instanceof Error && err.name === "AbortError"
            ? "timeout"
            : err instanceof Error
              ? err.message
              : "delete failed";
        setMessageState((prev) => ({ ...prev, dictionary: message }));
      } finally {
        clearTimeout(timeoutId);
        if (dictionaryActionRequestIdRef.current === requestId) {
          dictionaryActionInFlightRef.current = false;
        }
      }
    },
    [fetchDictionaryPage]
  );

  const handleDeleteTranslation = useCallback(
    async (tag: string) => {
      if (translationActionInFlightRef.current) return;
      if (!window.confirm(`Delete "${tag}"?`)) return;
      translationActionInFlightRef.current = true;
      const requestId = translationActionRequestIdRef.current + 1;
      translationActionRequestIdRef.current = requestId;
      const controller = new AbortController();
      translationActionAbortRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(`${API_BASE_URL}/api/tags/translations/${encodeURIComponent(tag)}`, {
          method: "DELETE",
          cache: "no-store",
          signal: controller.signal
        });
        const text = await response.text();
        if (translationActionRequestIdRef.current !== requestId) return;
        if (!response.ok) {
          setMessageState((prev) => ({ ...prev, translations: `HTTP ${response.status}` }));
          return;
        }
        let payload: any = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          setMessageState((prev) => ({ ...prev, translations: "Invalid response" }));
          return;
        }
        if (!payload || payload.ok !== true) {
          setMessageState((prev) => ({ ...prev, translations: payload?.error?.message || "Delete failed" }));
          return;
        }
        setMessageState((prev) => ({ ...prev, translations: "Deleted" }));
        fetchTranslationPage();
      } catch (err) {
        if (translationActionRequestIdRef.current !== requestId) return;
        const message =
          err instanceof Error && err.name === "AbortError"
            ? "timeout"
            : err instanceof Error
              ? err.message
              : "delete failed";
        setMessageState((prev) => ({ ...prev, translations: message }));
      } finally {
        clearTimeout(timeoutId);
        if (translationActionRequestIdRef.current === requestId) {
          translationActionInFlightRef.current = false;
        }
      }
    },
    [fetchTranslationPage]
  );
  const runBulkUpsert = async (endpoint: string, payload: unknown, signal?: AbortSignal) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: signal ?? controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        return { ok: false, message: `HTTP ${response.status}` };
      }
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        return { ok: false, message: "Invalid response" };
      }
      if (!parsed || parsed.ok !== true) {
        return { ok: false, message: parsed?.error?.message || "Invalid response" };
      }
      return { ok: true };
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : err instanceof Error
            ? err.message
            : "request failed";
      return { ok: false, message };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const handleDictionaryFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setDictionaryCsvFile(file);
    setImportState((prev) => ({
      ...prev,
      dictionary: { ...prev.dictionary, lastError: null, lastResultSummary: null }
    }));
  }, []);

  const handleDictionaryCsvUpload = useCallback(async () => {
    if (dictionaryImportInFlightRef.current) return;
    if (!dictionaryCsvFile) {
      setImportState((prev) => ({
        ...prev,
        dictionary: { ...prev.dictionary, phase: "error", lastError: "CSV file is required" }
      }));
      return;
    }
    if (dictionaryImportAbortRef.current) {
      dictionaryImportAbortRef.current.abort();
    }
    dictionaryImportInFlightRef.current = true;
    const requestId = dictionaryImportRequestIdRef.current + 1;
    dictionaryImportRequestIdRef.current = requestId;
    const controller = new AbortController();
    dictionaryImportAbortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    setImportState((prev) => ({
      ...prev,
      dictionary: {
        phase: "uploading",
        total: 0,
        sent: 0,
        failed: 0,
        lastError: null,
        lastResultSummary: null
      }
    }));

    try {
      const formData = new FormData();
      formData.append("file", dictionaryCsvFile);
      const response = await fetch(`${API_BASE_URL}/api/internals/tagcomplete/import-csv`, {
        method: "POST",
        body: formData,
        cache: "no-store",
        signal: controller.signal
      });
      const text = await response.text();
      if (dictionaryImportRequestIdRef.current !== requestId) return;
      if (!response.ok) {
        setImportState((prev) => ({
          ...prev,
          dictionary: {
            ...prev.dictionary,
            phase: "error",
            lastError: `HTTP ${response.status}`
          }
        }));
        return;
      }
      let payload: any = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        setImportState((prev) => ({
          ...prev,
          dictionary: { ...prev.dictionary, phase: "error", lastError: "Invalid response" }
        }));
        return;
      }
      if (!payload || payload.ok !== true || !payload.data) {
        setImportState((prev) => ({
          ...prev,
          dictionary: { ...prev.dictionary, phase: "error", lastError: payload?.error?.message || "Import failed" }
        }));
        return;
      }
      const totalRows = typeof payload.data.totalRows === "number" ? payload.data.totalRows : 0;
      const upserted = typeof payload.data.upserted === "number" ? payload.data.upserted : 0;
      const errorsSample = Array.isArray(payload.data.errorsSample) ? payload.data.errorsSample : [];
      const summary = `rows=${totalRows.toLocaleString()} upserted=${upserted.toLocaleString()} errors=${errorsSample.length}`;
      setImportState((prev) => ({
        ...prev,
        dictionary: {
          phase: errorsSample.length > 0 ? "error" : "success",
          total: totalRows,
          sent: upserted,
          failed: errorsSample.length,
          lastError: errorsSample.length > 0 ? "Some rows failed" : null,
          lastResultSummary: summary
        }
      }));
      setDictionaryCsvFile(null);
      if (dictImportRef.current) {
        dictImportRef.current.value = "";
      }
      fetchDictionaryPage();
    } catch (err) {
      if (dictionaryImportRequestIdRef.current !== requestId) return;
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : err instanceof Error
            ? err.message
            : "Import failed";
      setImportState((prev) => ({
        ...prev,
        dictionary: { ...prev.dictionary, phase: "error", lastError: message }
      }));
    } finally {
      clearTimeout(timeoutId);
      if (dictionaryImportRequestIdRef.current === requestId) {
        dictionaryImportInFlightRef.current = false;
      }
    }
  }, [dictionaryCsvFile, fetchDictionaryPage]);

  const handleTranslationImport = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    if (translationImportInFlightRef.current) return;
    const file = event.target.files?.[0];
    if (!file) return;
    translationImportInFlightRef.current = true;
    const requestId = translationImportRequestIdRef.current + 1;
    translationImportRequestIdRef.current = requestId;
    setImportState((prev) => ({
      ...prev,
      translations: { phase: "uploading", total: 0, sent: 0, failed: 0, lastError: null, lastResultSummary: null }
    }));
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { items?: unknown[]; entries?: unknown[] };
      const rawItems = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed?.entries) ? parsed.entries : [];
      const normalized = rawItems
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const record = item as Record<string, unknown>;
          const tag = typeof record.tag === "string" ? record.tag.trim() : "";
          const ja = typeof record.ja === "string" ? record.ja.trim() : "";
          if (!tag || !ja) return null;
          const source = typeof record.source === "string" ? record.source.trim() : "ollama";
          return { tag, ja, source };
        })
        .filter((item): item is { tag: string; ja: string; source: string } => !!item);
      if (normalized.length === 0) {
        setImportState((prev) => ({
          ...prev,
          translations: {
            phase: "error",
            total: 0,
            sent: 0,
            failed: 0,
            lastError: "No valid items",
            lastResultSummary: null
          }
        }));
        return;
      }

      const chunks = chunkArray(normalized, IMPORT_BATCH_SIZE);
      let sent = 0;
      let failed = 0;
      setImportState((prev) => ({
        ...prev,
        translations: {
          phase: "uploading",
          total: normalized.length,
          sent: 0,
          failed: 0,
          lastError: null,
          lastResultSummary: null
        }
      }));
      for (const chunk of chunks) {
        if (translationImportRequestIdRef.current !== requestId) return;
        const result = await runBulkUpsert("/api/tags/translations/bulk-upsert", { items: chunk });
        if (result.ok) {
          sent += chunk.length;
        } else {
          failed += chunk.length;
        }
        setImportState((prev) => ({
          ...prev,
          translations: {
            phase: "uploading",
            total: normalized.length,
            sent,
            failed,
            lastError: null,
            lastResultSummary: null
          }
        }));
      }
      setImportState((prev) => ({
        ...prev,
        translations: {
          phase: failed > 0 ? "error" : "success",
          total: normalized.length,
          sent,
          failed,
          lastError: failed > 0 ? "Some batches failed" : null,
          lastResultSummary: `total=${normalized.length.toLocaleString()} ok=${sent.toLocaleString()} failed=${failed.toLocaleString()}`
        }
      }));
      fetchTranslationPage();
    } catch (err) {
      if (translationImportRequestIdRef.current !== requestId) return;
      const message = err instanceof Error ? err.message : "Import failed";
      setImportState((prev) => ({
        ...prev,
        translations: {
          phase: "error",
          total: 0,
          sent: 0,
          failed: 0,
          lastError: message,
          lastResultSummary: null
        }
      }));
    } finally {
      translationImportInFlightRef.current = false;
      event.target.value = "";
    }
  }, [fetchTranslationPage]);

  const exportJson = (items: unknown[], filename: string) => {
    const payload = { items, savedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const activeDebug = activeTab === "dictionary" ? debugState.dictionary : debugState.translations;
  const activeMessage = activeTab === "dictionary" ? messageState.dictionary : messageState.translations;
  const activeImport = activeTab === "dictionary" ? importState.dictionary : importState.translations;

  const renderPagination = (tab: TabKey) => {
    const page = tab === "dictionary" ? dictionaryPage : translationPage;
    const total = tab === "dictionary" ? dictionaryTotal : translationTotal;
    const pageCount = tab === "dictionary" ? dictionaryPageCount : translationPageCount;
    const hasNext = tab === "dictionary" ? dictionaryHasNext : translationHasNext;
    const setPage = tab === "dictionary" ? setDictionaryPage : setTranslationPage;
    return (
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
        <span>
          Page {page + 1}
          {pageCount ? ` / ${pageCount}` : ""}
        </span>
        <span>Total: {total !== null ? total.toLocaleString() : "-"}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((prev) => Math.max(0, prev - 1))}
            disabled={page === 0}
            className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 transition hover:border-emerald-400/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Prev
          </button>
          <button
            type="button"
            onClick={() => setPage((prev) => prev + 1)}
            disabled={!hasNext}
            className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 transition hover:border-emerald-400/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>
    );
  };
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Internals</p>
        <h1 className="text-2xl font-semibold">Tag Library</h1>
        <p className="text-sm text-slate-400">Server paging via /api/tags/*</p>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 shadow-lg shadow-black/40">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveTab("dictionary")}
            className={`rounded-md border px-3 py-2 text-xs transition ${
              activeTab === "dictionary"
                ? "border-emerald-400/60 bg-emerald-500/10 text-emerald-100"
                : "border-slate-700 text-slate-300 hover:border-emerald-400/60 hover:text-white"
            }`}
          >
            Tag Dictionary
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("translations")}
            className={`rounded-md border px-3 py-2 text-xs transition ${
              activeTab === "translations"
                ? "border-emerald-400/60 bg-emerald-500/10 text-emerald-100"
                : "border-slate-700 text-slate-300 hover:border-emerald-400/60 hover:text-white"
            }`}
          >
            Translations
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 shadow-lg shadow-black/40">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-slate-400">Search</label>
          {activeTab === "dictionary" ? (
            <input
              value={dictionarySearch}
              onChange={(event) => setDictionarySearch(event.target.value)}
              className="w-full max-w-sm rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
              placeholder="tag / alias / type"
            />
          ) : (
            <input
              value={translationSearch}
              onChange={(event) => setTranslationSearch(event.target.value)}
              className="w-full max-w-sm rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
              placeholder="tag / ja"
            />
          )}
          <label className="text-xs text-slate-400">Limit</label>
          <select
            value={activeTab === "dictionary" ? dictionaryLimit : translationLimit}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (activeTab === "dictionary") {
                setDictionaryLimit(next);
              } else {
                setTranslationLimit(next);
              }
            }}
            className="rounded-md border border-slate-800 bg-slate-900 px-2 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              type="button"
              onClick={activeTab === "dictionary" ? fetchDictionaryPage : fetchTranslationPage}
              className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
            >
              Refresh
            </button>
            {activeTab === "dictionary" ? (
              <>
                <button
                  type="button"
                  onClick={() => exportJson(dictionaryItems, "tag_dictionary_page.json")}
                  className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
                >
                  Export Page
                </button>
                <button
                  type="button"
                  onClick={() => dictImportRef.current?.click()}
                  className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
                >
                  Select CSV
                </button>
                <button
                  type="button"
                  onClick={handleDictionaryCsvUpload}
                  disabled={!dictionaryCsvFile || importState.dictionary.phase === "uploading"}
                  className="rounded-md border border-emerald-500/60 px-3 py-2 text-xs text-emerald-100 transition hover:border-emerald-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Import
                </button>
                <button
                  type="button"
                  onClick={() => openDictionaryModal()}
                  className="rounded-md border border-emerald-500/60 px-3 py-2 text-xs text-emerald-100 transition hover:border-emerald-400 hover:text-white"
                >
                  Add Entry
                </button>
                <span className="text-xs text-slate-500">
                  CSV: {dictionaryCsvFile ? dictionaryCsvFile.name : "not selected"}
                </span>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => exportJson(translationItems, "tag_translations_page.json")}
                  className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
                >
                  Export Page
                </button>
                <button
                  type="button"
                  onClick={() => translationImportRef.current?.click()}
                  className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
                >
                  Import JSON
                </button>
                <button
                  type="button"
                  onClick={() => openTranslationModal()}
                  className="rounded-md border border-emerald-500/60 px-3 py-2 text-xs text-emerald-100 transition hover:border-emerald-400 hover:text-white"
                >
                  Add Entry
                </button>
              </>
            )}
            <input ref={dictImportRef} type="file" accept=".csv,text/csv" onChange={handleDictionaryFileChange} hidden />
            <input
              ref={translationImportRef}
              type="file"
              accept="application/json"
              onChange={handleTranslationImport}
              hidden
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          {renderPagination(activeTab)}
          {activeMessage && <span className="text-xs text-slate-400">{activeMessage}</span>}
        </div>
        {activeImport.phase !== "idle" && (
          <div className="mt-2 text-xs text-slate-400">
            <span>
              Import: {activeImport.phase} ({activeImport.sent}/{activeImport.total}) failed {activeImport.failed}
            </span>
            {activeImport.lastResultSummary && (
              <span className="ml-2">Result: {activeImport.lastResultSummary}</span>
            )}
            {activeImport.lastError && <span className="ml-2 text-rose-300">Error: {activeImport.lastError}</span>}
          </div>
        )}
      </section>

      {activeTab === "dictionary" ? (
        <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 shadow-lg shadow-black/40">
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-y-2 text-sm">
              <thead className="text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-3 text-left">Tag</th>
                  <th className="px-3 text-left">Type</th>
                  <th className="px-3 text-left">Count</th>
                  <th className="px-3 text-left">Aliases</th>
                  <th className="px-3 text-left">Updated</th>
                  <th className="px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {dictionaryItems.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-4 text-center text-slate-500">
                      No entries
                    </td>
                  </tr>
                )}
                {dictionaryItems.map((entry) => (
                  <tr key={entry.tag} className="rounded-lg bg-slate-900/60">
                    <td className="px-3 py-3 text-slate-100">{entry.tag}</td>
                    <td className="px-3 py-3 text-slate-300">{entry.type ?? "-"}</td>
                    <td className="px-3 py-3 text-slate-300">{entry.count ?? "-"}</td>
                    <td className="px-3 py-3 text-slate-400">
                      {(entry.aliases ?? []).join(", ") || "-"}
                    </td>
                    <td className="px-3 py-3 text-slate-400">{formatTimestamp(entry.updated_at ?? null)}</td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => openDictionaryModal(entry)}
                          className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteDictionary(entry.tag)}
                          className="rounded-md border border-rose-500/60 px-3 py-1 text-xs text-rose-200 transition hover:border-rose-300 hover:text-rose-100"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 shadow-lg shadow-black/40">
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-y-2 text-sm">
              <thead className="text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-3 text-left">Tag</th>
                  <th className="px-3 text-left">JA</th>
                  <th className="px-3 text-left">Source</th>
                  <th className="px-3 text-left">Seen</th>
                  <th className="px-3 text-left">Updated</th>
                  <th className="px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {translationItems.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-4 text-center text-slate-500">
                      No entries
                    </td>
                  </tr>
                )}
                {translationItems.map((entry) => (
                  <tr key={entry.tag} className="rounded-lg bg-slate-900/60">
                    <td className="px-3 py-3 text-slate-100">{entry.tag}</td>
                    <td className="px-3 py-3 text-slate-200">{entry.ja}</td>
                    <td className="px-3 py-3 text-slate-300">{entry.source}</td>
                    <td className="px-3 py-3 text-slate-300">{entry.seen_count ?? "-"}</td>
                    <td className="px-3 py-3 text-slate-400">{formatTimestamp(entry.updated_at ?? null)}</td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => openTranslationModal(entry)}
                          className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteTranslation(entry.tag)}
                          className="rounded-md border border-rose-500/60 px-3 py-1 text-xs text-rose-200 transition hover:border-rose-300 hover:text-rose-100"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 shadow-lg shadow-black/40">
        <h2 className="text-sm font-semibold text-slate-200">Debug</h2>
        <div className="mt-3 grid gap-3 text-xs text-slate-200">
          <div className="flex flex-wrap gap-4">
            <span>phase: {activeDebug.phase}</span>
            <span>lastUpdatedAt: {activeDebug.lastUpdatedAt ?? "-"}</span>
            <span>lastHttpStatus: {activeDebug.lastHttpStatus ?? "-"}</span>
          </div>
          <div className="flex flex-wrap gap-4">
            <span>lastError: {activeDebug.lastError ?? "-"}</span>
            <span>lastRequestUrl: {activeDebug.lastRequestUrl ?? "-"}</span>
          </div>
          <div>
            <p className="text-xs text-slate-400">lastRawText (truncated)</p>
            <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-300">
              {activeDebug.lastRawText ?? "-"}
            </pre>
          </div>
        </div>
      </section>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6">
          <div className="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Edit</p>
                <h2 className="text-lg font-semibold">{editingTag ? "Edit Entry" : "Add Entry"}</h2>
              </div>
              <button
                type="button"
                onClick={resetModal}
                className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
              >
                Close
              </button>
            </div>

            {modalTab === "dictionary" ? (
              <div className="mt-4 space-y-3">
                <label className="space-y-1 text-xs text-slate-400">
                  Tag
                  <input
                    value={dictionaryForm.tag}
                    onChange={(event) => setDictionaryForm((prev) => ({ ...prev, tag: event.target.value }))}
                    disabled={!!editingTag}
                    className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none disabled:opacity-70"
                  />
                </label>
                <label className="space-y-1 text-xs text-slate-400">
                  Type
                  <input
                    value={dictionaryForm.type}
                    onChange={(event) => setDictionaryForm((prev) => ({ ...prev, type: event.target.value }))}
                    className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
                  />
                </label>
                <label className="space-y-1 text-xs text-slate-400">
                  Count
                  <input
                    value={dictionaryForm.count}
                    onChange={(event) => setDictionaryForm((prev) => ({ ...prev, count: event.target.value }))}
                    className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
                  />
                </label>
                <label className="space-y-1 text-xs text-slate-400">
                  Aliases (comma/pipe)
                  <input
                    value={dictionaryForm.aliases}
                    onChange={(event) => setDictionaryForm((prev) => ({ ...prev, aliases: event.target.value }))}
                    className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleSaveDictionary}
                    className="rounded-md border border-emerald-500/60 px-4 py-2 text-xs text-emerald-100 transition hover:border-emerald-400 hover:text-white"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <label className="space-y-1 text-xs text-slate-400">
                  Tag
                  <input
                    value={translationForm.tag}
                    onChange={(event) => setTranslationForm((prev) => ({ ...prev, tag: event.target.value }))}
                    disabled={!!editingTag}
                    className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none disabled:opacity-70"
                  />
                </label>
                <label className="space-y-1 text-xs text-slate-400">
                  Japanese
                  <input
                    value={translationForm.ja}
                    onChange={(event) => setTranslationForm((prev) => ({ ...prev, ja: event.target.value }))}
                    className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
                  />
                </label>
                <label className="space-y-1 text-xs text-slate-400">
                  Source
                  <input
                    value={translationForm.source}
                    onChange={(event) => setTranslationForm((prev) => ({ ...prev, source: event.target.value }))}
                    disabled={!!editingTag}
                    className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none disabled:opacity-70"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleSaveTranslation}
                    className="rounded-md border border-emerald-500/60 px-4 py-2 text-xs text-emerald-100 transition hover:border-emerald-400 hover:text-white"
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
