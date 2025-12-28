import { API_BASE_URL } from "./api.js";

export type TagTranslationSource = "tagcomplete" | "observed" | "manual";

const translationCache = new Map<string, { ja: string; updatedAt: number }>();
const observedCount = new Map<string, number>();
const inFlightRequests = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const persistedEntries = new Map<string, { ja: string; source: TagTranslationSource }>();
const persistInFlight = new Map<string, Promise<void>>();
let ready = true;
let readyPromise: Promise<void> | null = null;
const PERSIST_BATCH_SIZE = 500;
const PERSIST_TIMEOUT_MS = 12000;

const notify = () => {
  for (const listener of listeners) {
    listener();
  }
};

const resolvePersistDecision = (tag: string, dictionaryTagSet?: Set<string> | null) => {
  const count = observedCount.get(tag) ?? 0;
  const inDictionary = dictionaryTagSet?.has(tag.toLowerCase()) ?? false;
  if (inDictionary) {
    return { persist: true, source: "tagcomplete" as const };
  }
  if (count >= 2) {
    return { persist: true, source: "observed" as const };
  }
  return { persist: false, source: "observed" as const };
};

export const initTranslationCache = () => {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    ready = true;
    notify();
  })();
  return readyPromise;
};

export const isTranslationCacheReady = () => ready;

export const getTranslationCache = () => translationCache;
export const getInFlightRequests = () => inFlightRequests;
export const getObservedCount = (tag: string) => observedCount.get(tag) ?? 0;

export const incrementObserved = (tag: string, delta: number) => {
  const next = (observedCount.get(tag) ?? 0) + delta;
  observedCount.set(tag, next);
};

export const subscribeTranslationCache = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const updateTranslationCache = (translations: Record<string, string>, updatedAt = Date.now()) => {
  let changed = false;
  for (const [tag, jaRaw] of Object.entries(translations)) {
    const ja = jaRaw.trim();
    if (!ja) continue;
    const existing = translationCache.get(tag);
    if (!existing || existing.ja !== ja) {
      translationCache.set(tag, { ja, updatedAt });
      changed = true;
    }
  }
  if (changed) {
    notify();
  }
};

export const persistTranslations = (translations: Record<string, string>, dictionaryTagSet?: Set<string> | null) => {
  if (!ready) return;
  const items: { tag: string; ja: string; source: TagTranslationSource }[] = [];

  for (const [tag, jaRaw] of Object.entries(translations)) {
    const ja = jaRaw.trim();
    if (!ja) continue;
    const decision = resolvePersistDecision(tag, dictionaryTagSet ?? null);
    if (!decision.persist) continue;
    const cached = persistedEntries.get(tag);
    if (cached && cached.ja === ja && cached.source === decision.source) continue;
    if (persistInFlight.has(tag)) continue;
    items.push({ tag, ja, source: decision.source });
  }
  if (items.length === 0) return;

  const chunks: { tag: string; ja: string; source: TagTranslationSource }[][] = [];
  for (let i = 0; i < items.length; i += PERSIST_BATCH_SIZE) {
    chunks.push(items.slice(i, i + PERSIST_BATCH_SIZE));
  }

  let runPromise: Promise<void>;
  const run = async () => {
    for (const chunk of chunks) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PERSIST_TIMEOUT_MS);
      let responseText = "";
      try {
        const response = await fetch(`${API_BASE_URL}/api/tags/translations/bulk-upsert`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: chunk }),
          cache: "no-store",
          signal: controller.signal
        });
        responseText = await response.text();
        if (!response.ok) {
          continue;
        }
        let payload: any = null;
        try {
          payload = responseText ? JSON.parse(responseText) : null;
        } catch {
          continue;
        }
        if (!payload || payload.ok !== true) {
          continue;
        }
        for (const item of chunk) {
          persistedEntries.set(item.tag, { ja: item.ja, source: item.source });
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }
  };

  runPromise = run().finally(() => {
    for (const item of items) {
      if (persistInFlight.get(item.tag) === runPromise) {
        persistInFlight.delete(item.tag);
      }
    }
  });

  for (const item of items) {
    persistInFlight.set(item.tag, runPromise);
  }
};
