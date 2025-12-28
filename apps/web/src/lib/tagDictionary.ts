import { idbGet, idbSet } from "./indexedDb.js";

const STORAGE_KEY = "muse.tagDictionary.v1";

export type TagDictionaryStoredEntry = {
  tag: string;
  type?: string;
  count?: number;
  aliases: string[];
};

export type TagDictionaryEntry = TagDictionaryStoredEntry & {
  tagLower: string;
  aliasesLower: string[];
};

export type TagDictionary = {
  entries: TagDictionaryEntry[];
  index: Map<string, number[]>;
};

export type TagSuggestion = TagDictionaryStoredEntry;

type ParseProgress = {
  processed: number;
  total: number;
};

const splitAliases = (value: string) =>
  value
    .split(/[|;]/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const parseCsvLine = (line: string) => {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  result.push(current);
  return result;
};

const yieldToMain = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

export const parseTagCsv = async (
  file: File,
  options?: { onProgress?: (progress: ParseProgress) => void }
): Promise<TagDictionaryStoredEntry[]> => {
  const text = await file.text();
  const lines = text.split(/\r?\n/);
  const entries: TagDictionaryStoredEntry[] = [];
  const seen = new Map<string, number>();
  const header = lines[0] ?? "";
  const hasHeader = /tag/i.test(header) && /type/i.test(header);
  const startIndex = hasHeader ? 1 : 0;
  const total = lines.length - startIndex;

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const [tagRaw, typeRaw, countRaw, aliasesRaw] = parseCsvLine(line);
    const tag = (tagRaw ?? "").trim();
    if (!tag) continue;
    const type = (typeRaw ?? "").trim() || undefined;
    const countValue = Number((countRaw ?? "").trim());
    const count = Number.isFinite(countValue) ? countValue : undefined;
    const aliases = aliasesRaw ? splitAliases(String(aliasesRaw)) : [];
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      const existingIndex = seen.get(key) ?? -1;
      const existing = entries[existingIndex];
      if (existing && count !== undefined && (existing.count ?? -1) < count) {
        entries[existingIndex] = {
          tag: existing.tag,
          type: existing.type,
          count,
          aliases: existing.aliases.length > 0 ? existing.aliases : aliases
        };
      }
    } else {
      seen.set(key, entries.length);
      entries.push({ tag, type, count, aliases });
    }

    if ((i - startIndex) % 2000 === 0) {
      options?.onProgress?.({ processed: i - startIndex, total });
      await yieldToMain();
    }
  }

  options?.onProgress?.({ processed: total, total });
  return entries;
};

export const buildTagDictionary = (entries: TagDictionaryStoredEntry[]): TagDictionary => {
  const normalized = entries.map((entry) => ({
    ...entry,
    tagLower: entry.tag.toLowerCase(),
    aliasesLower: entry.aliases.map((alias) => alias.toLowerCase())
  }));
  const index = new Map<string, number[]>();
  const addIndex = (key: string, idx: number) => {
    if (!key) return;
    const list = index.get(key);
    if (list) {
      list.push(idx);
    } else {
      index.set(key, [idx]);
    }
  };
  const addPrefixes = (value: string, idx: number) => {
    if (!value) return;
    addIndex(value.slice(0, 1), idx);
    if (value.length >= 2) {
      addIndex(value.slice(0, 2), idx);
    }
  };

  normalized.forEach((entry, idx) => {
    addPrefixes(entry.tagLower, idx);
    for (const alias of entry.aliasesLower) {
      addPrefixes(alias, idx);
    }
  });

  return { entries: normalized, index };
};

export const searchTagDictionary = (
  dictionary: TagDictionary,
  query: string,
  limit = 30
): TagSuggestion[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const key = normalized.length >= 2 ? normalized.slice(0, 2) : normalized;
  const candidates = dictionary.index.get(key) ?? [];
  const seen = new Set<number>();
  const matches: TagDictionaryEntry[] = [];

  for (const idx of candidates) {
    if (seen.has(idx)) continue;
    seen.add(idx);
    const entry = dictionary.entries[idx];
    if (
      entry.tagLower.startsWith(normalized) ||
      entry.aliasesLower.some((alias) => alias.startsWith(normalized))
    ) {
      matches.push(entry);
    }
  }

  matches.sort((a, b) => {
    const countA = a.count ?? 0;
    const countB = b.count ?? 0;
    if (countA !== countB) return countB - countA;
    return a.tag.localeCompare(b.tag);
  });

  return matches.slice(0, limit).map((entry) => ({
    tag: entry.tag,
    type: entry.type,
    count: entry.count,
    aliases: entry.aliases
  }));
};

export const saveTagDictionary = async (entries: TagDictionaryStoredEntry[]) => {
  const payload = { entries, savedAt: new Date().toISOString() };
  const stored = await idbSet(STORAGE_KEY, payload);
  if (stored) return true;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
};

export const loadTagDictionary = async (): Promise<TagDictionary | null> => {
  const fromIdb = await idbGet<{ entries?: TagDictionaryStoredEntry[] }>(STORAGE_KEY);
  if (fromIdb?.entries && Array.isArray(fromIdb.entries)) {
    return buildTagDictionary(fromIdb.entries);
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { entries?: TagDictionaryStoredEntry[] };
    if (!parsed?.entries || !Array.isArray(parsed.entries)) return null;
    return buildTagDictionary(parsed.entries);
  } catch {
    return null;
  }
};
