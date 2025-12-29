import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
  type MouseEvent,
  type ReactNode
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
  target?: "positive" | "negative";
};

type TagSuggestion = {
  tag: string;
  type?: string;
  count?: number;
  aliases?: string[];
};

type TagGroup = {
  id: number;
  label: string;
  sortOrder: number;
  filter: Record<string, unknown> | null;
};

type PromptTemplate = {
  id: number;
  name: string;
  target: "positive" | "negative" | "both";
  tokens: string[];
  sortOrder: number;
};

type PromptConflictRule = {
  id: number;
  a: string;
  b: string;
  severity: string;
  message: string | null;
};

type TagMetaCacheEntry = {
  tagType: number | null;
  updatedAt: number;
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
const TAG_GROUP_CACHE_TTL_MS = 5 * 60_000;
const TEMPLATE_CACHE_TTL_MS = 5 * 60_000;
const CONFLICT_CACHE_TTL_MS = 5 * 60_000;
const TAG_META_CACHE_TTL_MS = 10 * 60_000;
const tagMetaCache = new Map<string, TagMetaCacheEntry>();
const tagMetaInFlight = new Map<string, Promise<void>>();
const promptTagGroupCache: {
  data: TagGroup[] | null;
  updatedAt: number;
  inFlight: Promise<TagGroup[]> | null;
} = {
  data: null,
  updatedAt: 0,
  inFlight: null
};
const promptTemplateCache: {
  data: PromptTemplate[] | null;
  updatedAt: number;
  inFlight: Promise<PromptTemplate[]> | null;
} = {
  data: null,
  updatedAt: 0,
  inFlight: null
};
const promptConflictCache: {
  data: PromptConflictRule[] | null;
  updatedAt: number;
  inFlight: Promise<PromptConflictRule[]> | null;
} = {
  data: null,
  updatedAt: 0,
  inFlight: null
};

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

const normalizeGroupFilter = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
};

const parseTagTypeFilter = (filter: Record<string, unknown> | null) => {
  const raw = filter?.tag_type;
  if (!Array.isArray(raw)) return null;
  const values = raw.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  return values.length > 0 ? values : null;
};

const matchesTagGroupFilter = (filter: Record<string, unknown> | null, tagType: number | null) => {
  if (tagType === null) return false;
  const tagTypes = parseTagTypeFilter(filter);
  if (!tagTypes) return false;
  return tagTypes.includes(tagType);
};

const fetchPromptTagGroups = async () => {
  const now = Date.now();
  if (promptTagGroupCache.data && now - promptTagGroupCache.updatedAt < TAG_GROUP_CACHE_TTL_MS) {
    return promptTagGroupCache.data;
  }
  if (promptTagGroupCache.inFlight) return promptTagGroupCache.inFlight;

  const run = (async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/prompt/tag-groups`, { cache: "no-store" });
      const rawText = await response.text();
      if (!response.ok) return [];
      let payload: any = null;
      try {
        payload = rawText ? JSON.parse(rawText) : null;
      } catch {
        return [];
      }
      if (!payload || payload.ok !== true || !payload.data || !Array.isArray(payload.data.groups)) {
        return [];
      }
      const groups = (payload.data.groups as any[])
        .map((row) => {
          const id = Number(row?.id);
          const label = typeof row?.label === "string" ? row.label.trim() : "";
          if (!Number.isFinite(id) || !label) return null;
          const sortOrder = Number(row?.sort_order ?? row?.sortOrder ?? 0);
          return {
            id,
            label,
            sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
            filter: normalizeGroupFilter(row?.filter)
          } satisfies TagGroup;
        })
        .filter((item): item is TagGroup => item !== null)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
      promptTagGroupCache.data = groups;
      promptTagGroupCache.updatedAt = Date.now();
      return groups;
    } catch {
      return [];
    }
  })();

  promptTagGroupCache.inFlight = run;
  return run.finally(() => {
    if (promptTagGroupCache.inFlight === run) {
      promptTagGroupCache.inFlight = null;
    }
  });
};

const parseTemplateTokens = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean);
      }
    } catch {
      return value
        .split(/[,\n\r\t]+/g)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return [];
};

const fetchPromptTemplates = async () => {
  const now = Date.now();
  if (promptTemplateCache.data && now - promptTemplateCache.updatedAt < TEMPLATE_CACHE_TTL_MS) {
    return promptTemplateCache.data;
  }
  if (promptTemplateCache.inFlight) return promptTemplateCache.inFlight;

  const run = (async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/prompt/templates`, { cache: "no-store" });
      const rawText = await response.text();
      if (!response.ok) return [];
      let payload: any = null;
      try {
        payload = rawText ? JSON.parse(rawText) : null;
      } catch {
        return [];
      }
      if (!payload || payload.ok !== true || !payload.data || !Array.isArray(payload.data.templates)) {
        return [];
      }
      const templates = (payload.data.templates as any[])
        .map((row) => {
          const id = Number(row?.id);
          const name = typeof row?.name === "string" ? row.name.trim() : "";
          const target = row?.target;
          if (!Number.isFinite(id) || !name) return null;
          if (target !== "positive" && target !== "negative" && target !== "both") return null;
          const sortOrder = Number(row?.sort_order ?? row?.sortOrder ?? 0);
          return {
            id,
            name,
            target,
            sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
            tokens: parseTemplateTokens(row?.tokens)
          } satisfies PromptTemplate;
        })
        .filter((item): item is PromptTemplate => item !== null)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
      promptTemplateCache.data = templates;
      promptTemplateCache.updatedAt = Date.now();
      return templates;
    } catch {
      return [];
    }
  })();

  promptTemplateCache.inFlight = run;
  return run.finally(() => {
    if (promptTemplateCache.inFlight === run) {
      promptTemplateCache.inFlight = null;
    }
  });
};

const fetchPromptConflicts = async () => {
  const now = Date.now();
  if (promptConflictCache.data && now - promptConflictCache.updatedAt < CONFLICT_CACHE_TTL_MS) {
    return promptConflictCache.data;
  }
  if (promptConflictCache.inFlight) return promptConflictCache.inFlight;

  const run = (async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/prompt/conflicts`, { cache: "no-store" });
      const rawText = await response.text();
      if (!response.ok) return [];
      let payload: any = null;
      try {
        payload = rawText ? JSON.parse(rawText) : null;
      } catch {
        return [];
      }
      if (!payload || payload.ok !== true || !payload.data || !Array.isArray(payload.data.conflicts)) {
        return [];
      }
      const conflicts = (payload.data.conflicts as any[])
        .map((row) => {
          const id = Number(row?.id);
          const a = typeof row?.a === "string" ? row.a.trim() : "";
          const b = typeof row?.b === "string" ? row.b.trim() : "";
          if (!Number.isFinite(id) || !a || !b) return null;
          return {
            id,
            a,
            b,
            severity: typeof row?.severity === "string" ? row.severity : "warn",
            message: typeof row?.message === "string" ? row.message : null
          } satisfies PromptConflictRule;
        })
        .filter((item): item is PromptConflictRule => item !== null);
      promptConflictCache.data = conflicts;
      promptConflictCache.updatedAt = Date.now();
      return conflicts;
    } catch {
      return [];
    }
  })();

  promptConflictCache.inFlight = run;
  return run.finally(() => {
    if (promptConflictCache.inFlight === run) {
      promptConflictCache.inFlight = null;
    }
  });
};

const getTagMetaCache = (key: string) => {
  const cached = tagMetaCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.updatedAt > TAG_META_CACHE_TTL_MS) {
    tagMetaCache.delete(key);
    return null;
  }
  return cached;
};

const setTagMetaCache = (key: string, tagType: number | null) => {
  tagMetaCache.set(key, { tagType, updatedAt: Date.now() });
};

const fetchTagMeta = (tag: string) => {
  const key = normalizeTagKey(tag);
  if (!key) return Promise.resolve();
  const cached = getTagMetaCache(key);
  if (cached) return Promise.resolve();
  const inFlight = tagMetaInFlight.get(key);
  if (inFlight) return inFlight;

  const run = (async () => {
    if (key.length <= 1) {
      setTagMetaCache(key, null);
      return;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DICTIONARY_LOOKUP_TIMEOUT_MS);
    try {
      const params = new URLSearchParams({ query: tag, limit: "5", offset: "0" });
      const response = await fetch(`${API_BASE_URL}/api/tags/search?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal
      });
      const rawText = await response.text();
      if (!response.ok) {
        setTagMetaCache(key, null);
        return;
      }
      let payload: any = null;
      try {
        payload = rawText ? JSON.parse(rawText) : null;
      } catch {
        setTagMetaCache(key, null);
        return;
      }
      if (!payload || payload.ok !== true || !payload.data || !Array.isArray(payload.data.items)) {
        setTagMetaCache(key, null);
        return;
      }
      const items = payload.data.items as any[];
      let matched = items.find((item) => typeof item?.tag === "string" && item.tag.toLowerCase() === key);
      if (!matched && items.length > 0) matched = items[0];
      const tagType =
        matched && typeof matched.tagType === "number" && Number.isFinite(matched.tagType) ? matched.tagType : null;
      setTagMetaCache(key, tagType);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setTagMetaCache(key, null);
    } finally {
      clearTimeout(timeoutId);
    }
  })();

  tagMetaInFlight.set(key, run);
  return run.finally(() => {
    if (tagMetaInFlight.get(key) === run) {
      tagMetaInFlight.delete(key);
    }
  });
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
  onClear,
  target = "positive"
}: PromptComposerProps) {
  const tokens = useMemo(() => splitTokens(value), [value]);
  const uniqueTokens = useMemo(() => Array.from(new Set(tokens)), [tokens]);
  const [tagGroups, setTagGroups] = useState<TagGroup[]>([]);
  const [groupFilter, setGroupFilter] = useState("all");
  const [tagMetaVersion, setTagMetaVersion] = useState(0);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [conflicts, setConflicts] = useState<PromptConflictRule[]>([]);
  const sortedGroups = useMemo(() => {
    const next = [...tagGroups];
    next.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    return next;
  }, [tagGroups]);
  const groupLookup = useMemo(() => new Map(sortedGroups.map((group) => [group.id, group])), [sortedGroups]);
  const overrideGroupRef = useRef<Map<string, number>>(new Map());
  const resolveTokenGroup = useCallback(
    (token: string) => {
      const key = normalizeTagKey(token);
      if (!key) {
        return { id: "other", label: "Other", sortOrder: Number.MAX_SAFE_INTEGER };
      }
      const override = overrideGroupRef.current.get(key);
      if (override !== undefined) {
        const group = groupLookup.get(override);
        if (group) {
          return { id: group.id, label: group.label, sortOrder: group.sortOrder };
        }
      }
      const tagMeta = getTagMetaCache(key);
      const tagType = tagMeta?.tagType ?? null;
      for (const group of sortedGroups) {
        if (matchesTagGroupFilter(group.filter, tagType)) {
          return { id: group.id, label: group.label, sortOrder: group.sortOrder };
        }
      }
      return { id: "other", label: "Other", sortOrder: Number.MAX_SAFE_INTEGER };
    },
    [groupLookup, sortedGroups, tagMetaVersion]
  );
  const tokenItems = useMemo(
    () =>
      tokens.map((token, index) => {
        const group = resolveTokenGroup(token);
        return { id: `token-${index}`, value: token, index, groupId: group.id, groupLabel: group.label };
      }),
    [resolveTokenGroup, tokens]
  );
  const displayItems = useMemo(() => {
    if (groupFilter === "all") {
      const buckets = new Map<number | "other", typeof tokenItems>();
      for (const group of sortedGroups) {
        buckets.set(group.id, []);
      }
      buckets.set("other", []);
      for (const item of tokenItems) {
        const key = typeof item.groupId === "number" ? item.groupId : "other";
        const bucket = buckets.get(key) ?? buckets.get("other");
        if (bucket) bucket.push(item);
      }
      const ordered: typeof tokenItems = [];
      for (const group of sortedGroups) {
        const bucket = buckets.get(group.id);
        if (bucket && bucket.length > 0) {
          ordered.push(...bucket);
        }
      }
      const otherBucket = buckets.get("other");
      if (otherBucket && otherBucket.length > 0) {
        ordered.push(...otherBucket);
      }
      return ordered;
    }
    const selectedId = Number(groupFilter);
    if (!Number.isFinite(selectedId)) return tokenItems;
    return tokenItems.filter((item) => item.groupId === selectedId);
  }, [groupFilter, sortedGroups, tokenItems]);
  const tokenById = useMemo(() => new Map(tokenItems.map((item) => [item.id, item.value])), [tokenItems]);
  const groupedDisplayItems = useMemo(() => {
    if (groupFilter !== "all") {
      return displayItems.map((item) => ({ kind: "chip" as const, item }));
    }
    const result: Array<
      | { kind: "header"; key: string; label: string }
      | { kind: "chip"; item: typeof displayItems[number] }
    > = [];
    let lastGroupId: string | number | null = null;
    for (const item of displayItems) {
      if (item.groupId !== lastGroupId) {
        result.push({
          kind: "header",
          key: `header-${String(item.groupId)}-${item.index}`,
          label: item.groupLabel
        });
        lastGroupId = item.groupId;
      }
      result.push({ kind: "chip", item });
    }
    return result;
  }, [displayItems, groupFilter]);
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
  const templateMenuRef = useRef<HTMLDetailsElement | null>(null);
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
    fetchPromptTagGroups()
      .then((groups) => {
        if (cancelled) return;
        setTagGroups(groups);
      })
      .catch(() => {
        if (!cancelled) setTagGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchPromptTemplates()
      .then((items) => {
        if (cancelled) return;
        setTemplates(items);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchPromptConflicts()
      .then((items) => {
        if (cancelled) return;
        setConflicts(items);
      })
      .catch(() => {
        if (!cancelled) setConflicts([]);
      });
    return () => {
      cancelled = true;
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
    let cancelled = false;
    const uniqueTokens = Array.from(new Set(tokens.map((token) => normalizeTagKey(token)).filter((key) => key.length > 0)));
    if (uniqueTokens.length === 0) return undefined;
    const pending = uniqueTokens.filter((key) => getTagMetaCache(key) === null);
    if (pending.length === 0) return undefined;
    Promise.allSettled(pending.map((key) => fetchTagMeta(key))).then(() => {
      if (!cancelled) {
        setTagMetaVersion((prev) => prev + 1);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tokens]);

  useEffect(() => {
    if (editingIndex !== null && editingIndex >= tokens.length) {
      setEditingIndex(null);
      setEditingValue("");
    }
  }, [editingIndex, tokens.length]);

  useEffect(() => {
    if (groupFilter === "all") return;
    const id = Number(groupFilter);
    if (!Number.isFinite(id) || !tagGroups.some((group) => group.id === id)) {
      setGroupFilter("all");
    }
  }, [groupFilter, tagGroups]);

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

  const applicableTemplates = useMemo(
    () => templates.filter((template) => template.target === "both" || template.target === target),
    [target, templates]
  );

  const conflictMatches = useMemo(() => {
    if (conflicts.length === 0 || tokens.length === 0) return [];
    const tokenKeys = new Set(tokens.map(normalizeTokenKey).filter((key) => key.length > 0));
    if (tokenKeys.size === 0) return [];
    return conflicts.filter((rule) => {
      const aKey = normalizeTokenKey(rule.a);
      const bKey = normalizeTokenKey(rule.b);
      return aKey.length > 0 && bKey.length > 0 && tokenKeys.has(aKey) && tokenKeys.has(bKey);
    });
  }, [conflicts, tokens]);

  const conflictTagKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const rule of conflictMatches) {
      const aKey = normalizeTokenKey(rule.a);
      const bKey = normalizeTokenKey(rule.b);
      if (aKey) keys.add(aKey);
      if (bKey) keys.add(bKey);
    }
    return keys;
  }, [conflictMatches]);

  const conflictMessages = useMemo(() => {
    const messages: string[] = [];
    for (const rule of conflictMatches) {
      const text = rule.message && rule.message.trim().length > 0 ? rule.message.trim() : `${rule.a} × ${rule.b}`;
      if (!messages.includes(text)) {
        messages.push(text);
      }
    }
    return messages;
  }, [conflictMatches]);

  const canApplyGroups = sortedGroups.length > 0 && tokens.length > 1;

  const pushNotice = useCallback((message: string) => {
    setDedupNotice(message);
    if (dedupNoticeTimerRef.current) {
      clearTimeout(dedupNoticeTimerRef.current);
    }
    dedupNoticeTimerRef.current = setTimeout(() => {
      setDedupNotice(null);
    }, 2000);
  }, []);

  const handleDedup = () => {
    if (!dedupState.hasDuplicates) return;
    const result = dedupTokens(tokens);
    if (result.removedCount === 0) return;
    updateTokens(result.tokens);
    pushNotice(`Removed ${result.removedCount} duplicate${result.removedCount === 1 ? "" : "s"}`);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  const closeTemplateMenu = () => {
    if (templateMenuRef.current) {
      templateMenuRef.current.removeAttribute("open");
    }
  };

  const handleApplyTemplate = (template: PromptTemplate) => {
    if (template.tokens.length === 0) return;
    const next = dedupTokens([...tokens, ...template.tokens]);
    updateTokens(next.tokens);
    if (next.removedCount > 0) {
      pushNotice(`Removed ${next.removedCount} duplicate${next.removedCount === 1 ? "" : "s"}`);
    }
    closeTemplateMenu();
  };

  const handleAssignGroup = async (token: string, groupId: number | null, event?: MouseEvent<HTMLButtonElement>) => {
    event?.stopPropagation();
    const details = event?.currentTarget.closest("details");
    if (details) {
      details.removeAttribute("open");
    }
    const key = normalizeTagKey(token);
    if (!key) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/prompt/tag-group-overrides/${encodeURIComponent(token)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId }),
        cache: "no-store"
      });
      const text = await response.text();
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const payload = text ? JSON.parse(text) : null;
          message = payload?.error?.message || message;
        } catch {
          // ignore parse error
        }
        pushNotice(message);
        return;
      }
      if (groupId === null) {
        overrideGroupRef.current.delete(key);
      } else {
        overrideGroupRef.current.set(key, groupId);
      }
      setTagMetaVersion((prev) => prev + 1);
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError" ? "timeout" : err instanceof Error ? err.message : "failed";
      pushNotice(message);
    }
  };

  const renderAssignMenu = (token: string) => (
    <details className="relative">
      <summary
        onPointerDown={(event) => event.stopPropagation()}
        className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] text-slate-300 opacity-0 transition hover:bg-slate-700/40 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/60 group-hover:opacity-100"
        aria-label="Assign group"
      >
        ︙
      </summary>
      <div
        onPointerDown={(event) => event.stopPropagation()}
        className="absolute right-0 z-30 mt-2 min-w-[180px] rounded-md border border-slate-800 bg-slate-950 p-2 text-xs text-slate-200 shadow-lg"
      >
        <div className="px-2 pb-2 text-[10px] uppercase tracking-wide text-slate-500">Assign group</div>
        {sortedGroups.length === 0 ? (
          <div className="px-2 py-1 text-slate-500">No groups</div>
        ) : (
          <>
            <button
              type="button"
              onClick={(event) => handleAssignGroup(token, null, event)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition hover:bg-slate-800"
            >
              Other
            </button>
            {sortedGroups.map((group) => (
              <button
                key={group.id}
                type="button"
                onClick={(event) => handleAssignGroup(token, group.id, event)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition hover:bg-slate-800"
              >
                {group.label}
              </button>
            ))}
          </>
        )}
      </div>
    </details>
  );

  const handleApplyGroups = () => {
    if (sortedGroups.length === 0 || tokens.length <= 1) return;
    const buckets = new Map<number | "other", string[]>();
    for (const group of sortedGroups) {
      buckets.set(group.id, []);
    }
    buckets.set("other", []);
    for (const token of tokens) {
      const resolved = resolveTokenGroup(token);
      const key = typeof resolved.id === "number" ? resolved.id : "other";
      const bucket = buckets.get(key) ?? buckets.get("other");
      if (bucket) bucket.push(token);
    }
    const next: string[] = [];
    for (const group of sortedGroups) {
      const bucket = buckets.get(group.id);
      if (bucket && bucket.length > 0) {
        next.push(...bucket);
      }
    }
    const otherBucket = buckets.get("other");
    if (otherBucket && otherBucket.length > 0) {
      next.push(...otherBucket);
    }
    updateTokens(next);
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
    if (groupFilter !== "all") {
      setActiveId(null);
      setOverId(null);
      return;
    }
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const fromIndex = displayItems.findIndex((item) => item.id === active.id);
      const toIndex = displayItems.findIndex((item) => item.id === over.id);
      if (fromIndex !== -1 && toIndex !== -1) {
        const order = arrayMove(
          displayItems.map((item) => item.id),
          fromIndex,
          toIndex
        );
        const next = order.map((id) => tokenById.get(id)).filter((value): value is string => typeof value === "string");
        updateTokens(next);
      }
    }
    setActiveId(null);
    setOverId(null);
  };

  const handleDragCancel = () => {
    setActiveId(null);
    setOverId(null);
  };

  const dragEnabled = groupFilter === "all";

  const activeIndex = activeId ? displayItems.findIndex((item) => item.id === activeId) : -1;
  const overIndex = overId ? displayItems.findIndex((item) => item.id === overId) : -1;
  const insertPosition =
    activeIndex !== -1 && overIndex !== -1 && activeIndex !== overIndex
      ? activeIndex < overIndex
        ? "after"
        : "before"
      : null;

  const activeItem = activeId ? displayItems.find((item) => item.id === activeId) : null;

  const SortablePromptChip = ({
    id,
    value,
    index,
    insertPosition,
    disableDrag,
    menu,
    warning
  }: {
    id: string;
    value: string;
    index: number;
    insertPosition: "before" | "after" | null;
    disableDrag: boolean;
    menu?: ReactNode;
    warning?: boolean;
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
    const warningClass = warning ? "border-amber-400/50 bg-amber-500/10" : "";
    return (
      <div ref={setNodeRef} style={style} className={dragClass} {...dragProps}>
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
          menu={menu}
          rootProps={{ className: warningClass }}
        />
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="text-sm text-slate-300">{label}</label>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-500">Group</span>
            <select
              value={groupFilter}
              onChange={(event) => setGroupFilter(event.target.value)}
              className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
            >
              <option value="all">All</option>
              {sortedGroups.map((group) => (
                <option key={group.id} value={String(group.id)}>
                  {group.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={handleApplyGroups}
            disabled={!canApplyGroups}
            className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 transition hover:border-emerald-400/60 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Apply
          </button>
          <details ref={templateMenuRef} className="relative">
            <summary
              className={`rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 transition hover:border-emerald-400/60 hover:text-slate-100 ${
                applicableTemplates.length === 0 ? "pointer-events-none opacity-50" : ""
              }`}
            >
              Templates
            </summary>
            <div className="absolute right-0 z-30 mt-2 min-w-[200px] rounded-md border border-slate-800 bg-slate-950 p-2 text-xs text-slate-200 shadow-lg">
              {applicableTemplates.length === 0 ? (
                <div className="px-2 py-1 text-slate-500">No templates</div>
              ) : (
                applicableTemplates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => handleApplyTemplate(template)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left transition hover:bg-slate-800"
                  >
                    <span className="truncate">{template.name}</span>
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">{template.target}</span>
                  </button>
                ))
              )}
            </div>
          </details>
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
        <SortableContext items={displayItems.map((item) => item.id)} strategy={rectSortingStrategy}>
          <div
            className={`flex flex-wrap items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 ${
              activeId ? "ring-1 ring-emerald-400/40" : ""
            }`}
          >
            {tokens.length === 0 && inputValue.length === 0 && (
              <span className="text-xs text-slate-500">{placeholder ?? "Type and press Enter"}</span>
            )}
            {groupedDisplayItems.map((entry) =>
              entry.kind === "header" ? (
                <div key={entry.key} className="w-full pt-2 text-[11px] uppercase tracking-wide text-slate-500">
                  {entry.label}
                </div>
              ) : (
                <SortablePromptChip
                  key={entry.item.id}
                  id={entry.item.id}
                  value={entry.item.value}
                  index={entry.item.index}
                  insertPosition={overId === entry.item.id ? insertPosition : null}
                  disableDrag={!dragEnabled || editingIndex === entry.item.index}
                  warning={conflictTagKeys.has(normalizeTokenKey(entry.item.value))}
                  menu={renderAssignMenu(entry.item.value)}
                />
              )
            )}
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
      {conflictMessages.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <span className="font-semibold">Potential conflicts:</span> {conflictMessages.join(" / ")}
        </div>
      )}
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
