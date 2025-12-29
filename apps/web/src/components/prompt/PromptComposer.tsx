import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent
} from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, arrayMove, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import PromptChip from "./PromptChip.js";
import { API_BASE_URL } from "../../lib/api.js";
import {
  getTranslationCache,
  getInFlightRequests,
  getObservedCount,
  incrementObserved,
  initTranslationCache,
  isTranslationCacheReady,
  persistTranslations,
  subscribeTranslationCache,
  updateTranslationCache
} from "../../lib/translationCache.js";

type PromptComposerProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  suggestionLimit?: number;
  showClear?: boolean;
  onClear?: () => void;
};

type TagSuggestion = {
  tag: string;
  type?: string;
  count?: number;
  aliases?: string[];
};

const splitTokens = (value: string) =>
  value
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

const joinTokens = (tokens: string[]) => tokens.join(", ");

export const normalizeTokenKey = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

const dedupTokens = (tokens: string[]) => {
  const seen = new Set<string>();
  const next: string[] = [];
  let removedCount = 0;
  for (const token of tokens) {
    const key = normalizeTokenKey(token);
    if (seen.has(key)) {
      removedCount += 1;
      continue;
    }
    seen.add(key);
    next.push(token);
  }
  return { tokens: next, removedCount };
};

const TRANSLATE_BATCH_SIZE = 50;
const TRANSLATE_TIMEOUT_MS = 90000;
const LOOKUP_BATCH_SIZE = 200;
const LOOKUP_TIMEOUT_MS = 12000;
const SUGGEST_DEBOUNCE_MS = 260;
const SUGGEST_TIMEOUT_MS = 8000;
const DICTIONARY_LOOKUP_TIMEOUT_MS = 8000;
const DICTIONARY_CACHE_TTL_MS = 10 * 60 * 1000;
type TranslationStatus = "pending" | "done" | "error";

type TranslationEntry = {
  status: TranslationStatus;
  ja?: string;
  error?: string;
  updatedAt?: number;
  lookupChecked?: boolean;
};

const chunkArray = (items: string[], size: number) => {
  if (items.length === 0) return [];
  if (items.length <= size) return [items];
  const chunks: string[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const dictionaryTagCache = new Map<string, { exists: boolean; updatedAt: number }>();
const dictionaryTagSet = new Set<string>();
const dictionaryLookupInFlight = new Map<string, Promise<boolean>>();

const normalizeTagKey = (tag: string) => tag.trim().toLowerCase();

const getDictionaryCache = (tag: string) => {
  const key = normalizeTagKey(tag);
  if (!key) return null;
  const cached = dictionaryTagCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.updatedAt > DICTIONARY_CACHE_TTL_MS) {
    dictionaryTagCache.delete(key);
    dictionaryTagSet.delete(key);
    return null;
  }
  return cached.exists;
};

const setDictionaryTagResult = (key: string, exists: boolean) => {
  const now = Date.now();
  dictionaryTagCache.set(key, { exists, updatedAt: now });
  if (exists) {
    dictionaryTagSet.add(key);
  } else {
    dictionaryTagSet.delete(key);
  }
};

const markDictionaryTags = (tags: string[]) => {
  const now = Date.now();
  for (const tag of tags) {
    const key = normalizeTagKey(tag);
    if (!key) continue;
    dictionaryTagCache.set(key, { exists: true, updatedAt: now });
    dictionaryTagSet.add(key);
  }
};

const fetchDictionaryTagExists = (tag: string) => {
  const key = normalizeTagKey(tag);
  if (!key) return Promise.resolve(false);
  const cached = getDictionaryCache(tag);
  if (cached !== null) return Promise.resolve(cached);
  const inFlight = dictionaryLookupInFlight.get(key);
  if (inFlight) return inFlight;

  let runPromise: Promise<boolean>;
  const run = async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DICTIONARY_LOOKUP_TIMEOUT_MS);
    let responseText = "";
    try {
      const params = new URLSearchParams({ q: tag, limit: "5" });
      const response = await fetch(`${API_BASE_URL}/api/tags/dictionary?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal
      });
      responseText = await response.text();
      if (!response.ok) return false;
      let payload: any = null;
      try {
        payload = responseText ? JSON.parse(responseText) : null;
      } catch {
        return false;
      }
      if (!payload || payload.ok !== true || !payload.data || !Array.isArray(payload.data.items)) {
        return false;
      }
      const exists = payload.data.items.some(
        (item: any) => typeof item?.tag === "string" && item.tag.toLowerCase() === key
      );
      setDictionaryTagResult(key, exists);
      return exists;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return false;
      }
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  runPromise = run().finally(() => {
    if (dictionaryLookupInFlight.get(key) === runPromise) {
      dictionaryLookupInFlight.delete(key);
    }
  });
  dictionaryLookupInFlight.set(key, runPromise);
  return runPromise;
};

const ensureDictionaryTags = async (tags: string[]) => {
  const unique = Array.from(new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)));
  const pending = unique.filter((tag) => getDictionaryCache(tag) === null);
  if (pending.length === 0) return;
  const tasks = pending.map((tag) => fetchDictionaryTagExists(tag));
  await Promise.allSettled(tasks);
};

export default function PromptComposer({
  label,
  value,
  onChange,
  placeholder,
  suggestionLimit = 20,
  showClear = true,
  onClear
}: PromptComposerProps) {
  const tokens = useMemo(() => splitTokens(value), [value]);
  const uniqueTokens = useMemo(() => Array.from(new Set(tokens)), [tokens]);
  const items = useMemo(
    () => tokens.map((token, index) => ({ id: `token-${index}`, value: token })),
    [tokens]
  );
  const translationCache = getTranslationCache();
  const inFlightRequests = getInFlightRequests();
  const [inputValue, setInputValue] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [translationState, setTranslationState] = useState<Map<string, TranslationEntry>>(() => new Map());
  const [persistentReady, setPersistentReady] = useState(isTranslationCacheReady());
  const [dedupNotice, setDedupNotice] = useState<string | null>(null);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestAbortRef = useRef<AbortController | null>(null);
  const suggestRequestIdRef = useRef(0);
  const editCancelRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tokenCountRef = useRef(new Map<string, number>());
  const tagRequestIdRef = useRef(new Map<string, number>());
  const lookupRequestIdRef = useRef(0);
  const lookupTagRequestIdRef = useRef(new Map<string, number>());
  const translateRequestIdRef = useRef(0);
  const forceQueueRef = useRef(new Set<string>());
  const tokenSetRef = useRef<Set<string>>(new Set());
  const activeRef = useRef(true);
  const dedupNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } })
  );

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (dedupNoticeTimerRef.current) {
        clearTimeout(dedupNoticeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    initTranslationCache()
      .then(() => {
        if (cancelled) return;
        setPersistentReady(true);
        if (tokenSetRef.current.size === 0) return;
        setTranslationState((prev) => {
          const next = new Map(prev);
          let changed = false;
          for (const tag of tokenSetRef.current) {
            const cached = translationCache.get(tag);
            if (cached) {
              next.set(tag, { status: "done", ja: cached.ja, updatedAt: cached.updatedAt, lookupChecked: true });
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      })
      .catch(() => {
        if (!cancelled) setPersistentReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [translationCache]);

  useEffect(() => {
    const syncFromCache = () => {
      if (tokenSetRef.current.size === 0) return;
      setTranslationState((prev) => {
        const next = new Map(prev);
        let changed = false;
        for (const tag of tokenSetRef.current) {
          const cached = translationCache.get(tag);
          if (!cached) continue;
          const existing = next.get(tag);
          if (!existing || existing.status !== "done" || existing.ja !== cached.ja) {
            next.set(tag, { status: "done", ja: cached.ja, updatedAt: cached.updatedAt, lookupChecked: true });
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    const unsubscribe = subscribeTranslationCache(syncFromCache);
    syncFromCache();
    return () => {
      unsubscribe();
    };
  }, [translationCache]);

  useEffect(() => {
    if (editingIndex !== null && editingIndex >= tokens.length) {
      setEditingIndex(null);
      setEditingValue("");
    }
  }, [editingIndex, tokens.length]);

  const queuePersistTranslations = useCallback((translations: Record<string, string>) => {
    const tags = Object.keys(translations);
    if (tags.length === 0) return;
    persistTranslations(translations, dictionaryTagSet);
    const unknownTags = tags.filter((tag) => getObservedCount(tag) < 2 && getDictionaryCache(tag) === null);
    if (unknownTags.length > 0) {
      void ensureDictionaryTags(unknownTags).finally(() => {
        persistTranslations(translations, dictionaryTagSet);
      });
    }
  }, []);

  useEffect(() => {
    const nextCounts = new Map<string, number>();
    const observedTags: string[] = [];
    for (const token of tokens) {
      nextCounts.set(token, (nextCounts.get(token) ?? 0) + 1);
    }
    const prevCounts = tokenCountRef.current;
    for (const [tag, count] of nextCounts) {
      const prevCount = prevCounts.get(tag) ?? 0;
      if (count > prevCount) {
        incrementObserved(tag, count - prevCount);
        observedTags.push(tag);
      }
    }
    tokenCountRef.current = nextCounts;

    const prevSet = tokenSetRef.current;
    const nextSet = new Set(uniqueTokens);
    tokenSetRef.current = nextSet;

    if (nextSet.size === 0) {
      forceQueueRef.current.clear();
      setTranslationState((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }

    setTranslationState((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const key of next.keys()) {
        if (!nextSet.has(key)) {
          next.delete(key);
          changed = true;
        }
      }
      for (const tag of nextSet) {
        if (!next.has(tag)) {
          const cached = translationCache.get(tag);
          if (cached) {
            next.set(tag, { status: "done", ja: cached.ja, updatedAt: cached.updatedAt, lookupChecked: true });
          } else {
            next.set(tag, { status: "pending", updatedAt: Date.now(), lookupChecked: false });
          }
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    const cachedToPersist: Record<string, string> = {};
    const newlyAddedTags: string[] = [];
    for (const tag of nextSet) {
      if (!prevSet.has(tag)) {
        newlyAddedTags.push(tag);
      }
    }
    const candidates = new Set([...newlyAddedTags, ...observedTags]);
    for (const tag of candidates) {
      const cached = translationCache.get(tag);
      if (cached) {
        cachedToPersist[tag] = cached.ja;
      }
    }
    if (Object.keys(cachedToPersist).length > 0) {
      queuePersistTranslations(cachedToPersist);
    }
  }, [queuePersistTranslations, tokens, translationCache, uniqueTokens]);

  useEffect(() => {
    if (suggestTimerRef.current) {
      clearTimeout(suggestTimerRef.current);
    }
    const query = inputValue.trim();
    if (query.length === 0) {
      if (suggestAbortRef.current) {
        suggestAbortRef.current.abort();
        suggestAbortRef.current = null;
      }
      setSuggestions([]);
      setSuggestOpen(false);
      return;
    }
    const requestId = suggestRequestIdRef.current + 1;
    suggestRequestIdRef.current = requestId;
    suggestTimerRef.current = setTimeout(() => {
      if (requestId !== suggestRequestIdRef.current) return;
      if (suggestAbortRef.current) {
        suggestAbortRef.current.abort();
      }
      const controller = new AbortController();
      suggestAbortRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS);
      const limit = Math.min(suggestionLimit, 20);
      const params = new URLSearchParams({ q: query, limit: String(limit) });

      const run = async () => {
        let responseText = "";
        try {
          const response = await fetch(`${API_BASE_URL}/api/tags/dictionary?${params.toString()}`, {
            cache: "no-store",
            signal: controller.signal
          });
          responseText = await response.text();
          if (!activeRef.current || requestId !== suggestRequestIdRef.current) return;
          if (!response.ok) {
            setSuggestions([]);
            setSuggestOpen(false);
            return;
          }
          let payload: any = null;
          try {
            payload = responseText ? JSON.parse(responseText) : null;
          } catch {
            setSuggestions([]);
            setSuggestOpen(false);
            return;
          }
          if (!payload || payload.ok !== true || !payload.data || !Array.isArray(payload.data.items)) {
            setSuggestions([]);
            setSuggestOpen(false);
            return;
          }
          const results: TagSuggestion[] = [];
          for (const item of payload.data.items as any[]) {
            if (!item || typeof item.tag !== "string") continue;
            const rawAliases = Array.isArray(item.aliases) ? (item.aliases as unknown[]) : [];
            results.push({
              tag: item.tag,
              type: typeof item.type === "string" ? item.type : undefined,
              count: typeof item.count === "number" ? item.count : undefined,
              aliases: rawAliases.filter((alias): alias is string => typeof alias === "string")
            });
          }
          markDictionaryTags(results.map((item) => item.tag));
          if (!activeRef.current || requestId !== suggestRequestIdRef.current) return;
          setSuggestions(results);
          setSuggestOpen(results.length > 0);
        } catch (err) {
          if (!activeRef.current || requestId !== suggestRequestIdRef.current) return;
          if (err instanceof Error && err.name === "AbortError") return;
          setSuggestions([]);
          setSuggestOpen(false);
        } finally {
          clearTimeout(timeoutId);
        }
      };

      void run();
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      if (suggestTimerRef.current) {
        clearTimeout(suggestTimerRef.current);
      }
    };
  }, [inputValue, suggestionLimit]);

  const queueForceTranslation = useCallback((tags: string[]) => {
    if (tags.length === 0) return;
    const requestId = translateRequestIdRef.current + 1;
    translateRequestIdRef.current = requestId;
    const now = Date.now();
    setTranslationState((prev) => {
      const next = new Map(prev);
      for (const tag of tags) {
        next.set(tag, { status: "pending", updatedAt: now, lookupChecked: true });
      }
      return next;
    });
    for (const tag of tags) {
      forceQueueRef.current.add(tag);
      tagRequestIdRef.current.set(tag, requestId);
      lookupTagRequestIdRef.current.delete(tag);
      inFlightRequests.delete(tag);
    }
  }, []);

  const startLookupBatch = useCallback((tags: string[]) => {
    if (tags.length === 0) return;
    const requestId = lookupRequestIdRef.current + 1;
    lookupRequestIdRef.current = requestId;
    const now = Date.now();

    setTranslationState((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const tag of tags) {
        const existing = next.get(tag);
        if (existing?.status === "pending" && !existing.lookupChecked) {
          next.set(tag, { ...existing, lookupChecked: true, updatedAt: now });
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    for (const tag of tags) {
      lookupTagRequestIdRef.current.set(tag, requestId);
    }

    let runPromise: Promise<void>;
    const run = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
      let responseText = "";
      let resolvedForCache: Record<string, string> = {};

      try {
        const response = await fetch(`${API_BASE_URL}/api/tags/translations/lookup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags }),
          cache: "no-store",
          signal: controller.signal
        });
        responseText = await response.text();
        if (!response.ok) {
          return;
        }
        let payload: any = null;
        try {
          payload = responseText ? JSON.parse(responseText) : null;
        } catch {
          return;
        }
        if (!payload || payload.ok !== true || !payload.data || typeof payload.data.translations !== "object") {
          return;
        }
        const rawTranslations = payload.data.translations as Record<string, string>;
        for (const tag of tags) {
          if (lookupTagRequestIdRef.current.get(tag) !== requestId) continue;
          if (!tokenSetRef.current.has(tag)) continue;
          const raw = rawTranslations[tag];
          if (typeof raw !== "string") continue;
          const trimmed = raw.trim();
          if (!trimmed) continue;
          resolvedForCache[tag] = trimmed;
        }
        if (Object.keys(resolvedForCache).length > 0) {
          const updateAt = Date.now();
          updateTranslationCache(resolvedForCache, updateAt);
          if (activeRef.current) {
            setTranslationState((prev) => {
              const next = new Map(prev);
              let changed = false;
              for (const [tag, ja] of Object.entries(resolvedForCache)) {
                if (lookupTagRequestIdRef.current.get(tag) !== requestId) continue;
                if (!tokenSetRef.current.has(tag)) continue;
                const existing = next.get(tag);
                if (existing?.status === "done") continue;
                next.set(tag, { status: "done", ja, updatedAt: updateAt, lookupChecked: true });
                changed = true;
              }
              return changed ? next : prev;
            });
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
      } finally {
        clearTimeout(timeoutId);
        if (activeRef.current) {
          const updateAt = Date.now();
          setTranslationState((prev) => {
            const next = new Map(prev);
            let changed = false;
            for (const tag of tags) {
              if (lookupTagRequestIdRef.current.get(tag) !== requestId) continue;
              if (!tokenSetRef.current.has(tag)) continue;
              const existing = next.get(tag);
              if (existing?.status === "pending") {
                next.set(tag, { ...existing, updatedAt: updateAt, lookupChecked: true });
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }
        for (const tag of tags) {
          if (inFlightRequests.get(tag) === runPromise) {
            inFlightRequests.delete(tag);
          }
        }
      }
    };

    runPromise = run();

    for (const tag of tags) {
      inFlightRequests.set(tag, runPromise);
    }

    return runPromise;
  }, []);

  const startTranslationBatch = useCallback(
    (tags: string[], force: boolean) => {
      if (tags.length === 0) return;
      const requestId = translateRequestIdRef.current + 1;
      translateRequestIdRef.current = requestId;
      for (const tag of tags) {
        tagRequestIdRef.current.set(tag, requestId);
      }
      if (force) {
        for (const tag of tags) {
          forceQueueRef.current.delete(tag);
        }
      }

      let runPromise: Promise<void>;
      const execute = async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
        let responseText = "";

        const applyError = (message: string) => {
          if (!activeRef.current) return;
          const now = Date.now();
          setTranslationState((prev) => {
            const next = new Map(prev);
            let changed = false;
            for (const tag of tags) {
              if (tagRequestIdRef.current.get(tag) !== requestId) continue;
              if (!tokenSetRef.current.has(tag)) continue;
              const existing = next.get(tag);
              if (!existing || existing.status !== "error" || existing.error !== message) {
                next.set(tag, { status: "error", error: message, updatedAt: now });
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        };

        try {
          const response = await fetch(`${API_BASE_URL}/api/ollama/translate-tags`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tags, ...(force ? { force: true } : {}) }),
            cache: "no-store",
            signal: controller.signal
          });

          responseText = await response.text();
          if (!response.ok) {
            applyError(`HTTP ${response.status}`);
            return;
          }

          let payload: any = null;
          try {
            payload = responseText ? JSON.parse(responseText) : null;
          } catch {
            applyError("Invalid response");
            return;
          }

          if (!payload || payload.ok !== true || !payload.data || typeof payload.data.translations !== "object") {
            applyError(payload?.error?.message || "Invalid response");
            return;
          }

          const rawTranslations = payload.data.translations as Record<string, string>;
          const resolved: Record<string, string> = {};
          for (const tag of tags) {
            const raw = rawTranslations[tag];
            resolved[tag] = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : tag;
          }

          const now = Date.now();
          const resolvedForCache: Record<string, string> = {};
          for (const tag of tags) {
            if (tagRequestIdRef.current.get(tag) !== requestId) continue;
            resolvedForCache[tag] = resolved[tag];
          }
          if (activeRef.current) {
            setTranslationState((prev) => {
              const next = new Map(prev);
              let changed = false;
              for (const tag of tags) {
                if (tagRequestIdRef.current.get(tag) !== requestId) continue;
                if (!tokenSetRef.current.has(tag)) continue;
                next.set(tag, { status: "done", ja: resolved[tag], updatedAt: now, lookupChecked: true });
                changed = true;
              }
              return changed ? next : prev;
            });
          }

          if (Object.keys(resolvedForCache).length > 0) {
            updateTranslationCache(resolvedForCache, now);
            queuePersistTranslations(resolvedForCache);
          }
        } catch (err) {
          const message =
            err instanceof Error && err.name === "AbortError"
              ? "timeout"
              : err instanceof Error
                ? err.message
                : "translate failed";
          applyError(message);
        } finally {
          clearTimeout(timeoutId);
          for (const tag of tags) {
            if (inFlightRequests.get(tag) === runPromise) {
              inFlightRequests.delete(tag);
            }
          }
        }
      };

      runPromise = execute();

      for (const tag of tags) {
        inFlightRequests.set(tag, runPromise);
      }

      return runPromise;
    },
    [queuePersistTranslations, updateTranslationCache]
  );

  useEffect(() => {
    if (!persistentReady) return;
    if (uniqueTokens.length === 0) return;
    const lookupTags = uniqueTokens.filter((tag) => {
      const entry = translationState.get(tag);
      if (!entry || entry.status !== "pending") return false;
      if (entry.lookupChecked) return false;
      if (forceQueueRef.current.has(tag)) return false;
      if (inFlightRequests.has(tag)) return false;
      return true;
    });
    if (lookupTags.length === 0) return;
    for (const chunk of chunkArray(lookupTags, LOOKUP_BATCH_SIZE)) {
      startLookupBatch(chunk);
    }
  }, [persistentReady, startLookupBatch, translationState, uniqueTokens]);

  useEffect(() => {
    if (!persistentReady) return;
    if (uniqueTokens.length === 0) return;
    const pendingTags = uniqueTokens.filter((tag) => {
      const entry = translationState.get(tag);
      return entry?.status === "pending" && !inFlightRequests.has(tag);
    });
    if (pendingTags.length === 0) return;

    const forceTags = pendingTags.filter((tag) => forceQueueRef.current.has(tag));
    const normalTags = pendingTags.filter((tag) => !forceQueueRef.current.has(tag));

    for (const chunk of chunkArray(forceTags, TRANSLATE_BATCH_SIZE)) {
      startTranslationBatch(chunk, true);
    }
    for (const chunk of chunkArray(normalTags, TRANSLATE_BATCH_SIZE)) {
      startTranslationBatch(chunk, false);
    }
  }, [persistentReady, startTranslationBatch, translationState, uniqueTokens]);

  const updateTokens = (nextTokens: string[]) => {
    onChange(joinTokens(nextTokens));
  };

  const appendTokens = (raw: string) => {
    const next = splitTokens(raw);
    if (next.length === 0) return;
    updateTokens([...tokens, ...next]);
    setInputValue("");
    setSuggestOpen(false);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const hasSuggestion = suggestOpen && suggestions.length > 0;
    if (event.key === "Enter" || event.key === "Tab" || event.key === ",") {
      event.preventDefault();
      if (hasSuggestion) {
        appendTokens(suggestions[0].tag);
      } else {
        appendTokens(inputValue);
      }
    }
  };

  const handleInputPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!/[,\n\r\t]/.test(text)) return;
    event.preventDefault();
    const pastedTokens = text
      .split(/[,\n\r\t]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    if (pastedTokens.length === 0) return;
    updateTokens([...tokens, ...pastedTokens]);
    setInputValue("");
    setSuggestOpen(false);
  };

  const startEdit = (index: number) => {
    setEditingIndex(index);
    setEditingValue(tokens[index] ?? "");
    editCancelRef.current = false;
  };

  const handleEditSubmit = () => {
    if (editCancelRef.current) {
      editCancelRef.current = false;
      return;
    }
    if (editingIndex === null) return;
    const next = [...tokens];
    const nextValue = editingValue.trim();
    if (nextValue.length === 0) {
      next.splice(editingIndex, 1);
    } else {
      next[editingIndex] = nextValue;
    }
    setEditingIndex(null);
    setEditingValue("");
    updateTokens(next);
  };

  const handleEditCancel = () => {
    editCancelRef.current = true;
    setEditingIndex(null);
    setEditingValue("");
  };

  const removeToken = (index: number) => {
    const next = tokens.filter((_, idx) => idx !== index);
    updateTokens(next);
  };

  const handleSuggestionClick = (tag: string) => {
    appendTokens(tag);
  };

  const handleClear = () => {
    if (tokens.length === 0) return;
    setEditingIndex(null);
    setEditingValue("");
    setInputValue("");
    setSuggestions([]);
    setSuggestOpen(false);
    setDedupNotice(null);
    if (onClear) {
      onClear();
    } else {
      onChange("");
    }
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  const dedupState = useMemo(() => {
    if (tokens.length <= 1) return { hasDuplicates: false, removedCount: 0 };
    const seen = new Set<string>();
    let removedCount = 0;
    for (const token of tokens) {
      const key = normalizeTokenKey(token);
      if (seen.has(key)) {
        removedCount += 1;
      } else {
        seen.add(key);
      }
    }
    return { hasDuplicates: removedCount > 0, removedCount };
  }, [tokens]);

  const handleDedup = () => {
    if (!dedupState.hasDuplicates) return;
    const result = dedupTokens(tokens);
    if (result.removedCount === 0) return;
    updateTokens(result.tokens);
    setDedupNotice(`Removed ${result.removedCount} duplicate${result.removedCount === 1 ? "" : "s"}`);
    if (dedupNoticeTimerRef.current) {
      clearTimeout(dedupNoticeTimerRef.current);
    }
    dedupNoticeTimerRef.current = setTimeout(() => {
      setDedupNotice(null);
    }, 2000);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  const handleRetranslateToken = (tag: string) => {
    queueForceTranslation([tag]);
  };

  const handleRetranslateAll = () => {
    if (uniqueTokens.length === 0) return;
    queueForceTranslation(uniqueTokens);
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    setInputValue(event.target.value);
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragOver = (event: DragOverEvent) => {
    setOverId(event.over ? String(event.over.id) : null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const fromIndex = items.findIndex((item) => item.id === active.id);
      const toIndex = items.findIndex((item) => item.id === over.id);
      if (fromIndex !== -1 && toIndex !== -1) {
        updateTokens(arrayMove(tokens, fromIndex, toIndex));
      }
    }
    setActiveId(null);
    setOverId(null);
  };

  const handleDragCancel = () => {
    setActiveId(null);
    setOverId(null);
  };

  const activeIndex = activeId ? items.findIndex((item) => item.id === activeId) : -1;
  const overIndex = overId ? items.findIndex((item) => item.id === overId) : -1;
  const insertPosition =
    activeIndex !== -1 && overIndex !== -1 && activeIndex !== overIndex
      ? activeIndex < overIndex
        ? "after"
        : "before"
      : null;

  const activeItem = activeId ? items.find((item) => item.id === activeId) : null;

  const SortablePromptChip = ({
    id,
    value,
    index,
    insertPosition,
    disableDrag
  }: {
    id: string;
    value: string;
    index: number;
    insertPosition: "before" | "after" | null;
    disableDrag: boolean;
  }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
      id,
      disabled: disableDrag
    });
    const style = {
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0.4 : undefined
    };
    const dragProps = disableDrag ? {} : { ...attributes, ...listeners };
    const dragClass = disableDrag ? "relative" : "relative cursor-grab active:cursor-grabbing";
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={dragClass}
        {...dragProps}
      >
        {insertPosition === "before" && (
          <span className="pointer-events-none absolute -left-1 top-1 bottom-1 w-0.5 rounded bg-emerald-400" />
        )}
        {insertPosition === "after" && (
          <span className="pointer-events-none absolute -right-1 top-1 bottom-1 w-0.5 rounded bg-emerald-400" />
        )}
        <PromptChip
          value={value}
          isEditing={editingIndex === index}
          editValue={editingIndex === index ? editingValue : ""}
          onEditChange={setEditingValue}
          onEditSubmit={handleEditSubmit}
          onEditCancel={handleEditCancel}
          onStartEdit={() => startEdit(index)}
          onRemove={() => removeToken(index)}
          translation={translationState.get(value) ?? { status: "pending" }}
          onRetranslate={() => handleRetranslateToken(value)}
        />
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-sm text-slate-300">{label}</label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDedup}
            disabled={tokens.length <= 1 || !dedupState.hasDuplicates}
            className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 transition hover:border-emerald-400/60 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Dedup
          </button>
          {showClear && (
            <button
              type="button"
              onClick={handleClear}
              disabled={tokens.length === 0}
              className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 transition hover:border-emerald-400/60 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={handleRetranslateAll}
            disabled={uniqueTokens.length === 0}
            className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 transition hover:border-emerald-400/60 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Re-translate all
          </button>
          <button
            type="button"
            onClick={() => setShowRaw((prev) => !prev)}
            className="text-xs text-slate-400 transition hover:text-slate-100"
          >
            {showRaw ? "Hide raw" : "Show raw"}
          </button>
        </div>
      </div>
      {dedupNotice && <div className="text-xs text-emerald-300">{dedupNotice}</div>}
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={items.map((item) => item.id)} strategy={rectSortingStrategy}>
          <div
            className={`flex flex-wrap items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 ${
              activeId ? "ring-1 ring-emerald-400/40" : ""
            }`}
          >
            {tokens.length === 0 && inputValue.length === 0 && (
              <span className="text-xs text-slate-500">{placeholder ?? "Type and press Enter"}</span>
            )}
            {items.map((item, index) => (
              <SortablePromptChip
                key={item.id}
                id={item.id}
                value={item.value}
                index={index}
                insertPosition={overId === item.id ? insertPosition : null}
                disableDrag={editingIndex === index}
              />
            ))}
            <div className="relative min-w-[160px] flex-1">
              <input
                ref={inputRef}
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleInputKeyDown}
                onPaste={handleInputPaste}
                onFocus={() => {
                  if (suggestions.length > 0) setSuggestOpen(true);
                }}
                onBlur={() => {
                  setTimeout(() => setSuggestOpen(false), 120);
                }}
                className="w-full bg-transparent text-xs text-slate-100 focus:outline-none"
              />
              {suggestOpen && suggestions.length > 0 && (
                <div className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-md border border-slate-800 bg-slate-950 text-xs text-slate-200 shadow-lg">
                  {suggestions.map((item) => (
                    <button
                      key={item.tag}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handleSuggestionClick(item.tag)}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-slate-800"
                    >
                      <span className="truncate">{item.tag}</span>
                      {typeof item.count === "number" && (
                        <span className="text-[11px] text-slate-500">{item.count.toLocaleString()}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </SortableContext>
        <DragOverlay>
          {activeItem ? (
            <div className="opacity-80">
              <PromptChip
                value={activeItem.value}
                isEditing={false}
                editValue=""
                onEditChange={() => undefined}
                onEditSubmit={() => undefined}
                onEditCancel={() => undefined}
                onStartEdit={() => undefined}
                onRemove={() => undefined}
                translation={translationState.get(activeItem.value) ?? { status: "pending" }}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {showRaw && (
        <textarea
          readOnly
          value={value}
          className="h-20 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-300 focus:outline-none"
        />
      )}
    </div>
  );
}
