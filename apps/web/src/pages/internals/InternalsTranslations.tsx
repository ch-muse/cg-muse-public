import { useMemo, useRef, useState, useEffect, type ChangeEvent } from "react";
import { API_BASE_URL } from "../../lib/api.js";
import { idbGet, idbSet } from "../../lib/indexedDb.js";

const STORAGE_KEY = "muse.tagTranslations.v1";
const TRANSLATE_TIMEOUT_MS = 90000;

type TagTranslationSource = "tagcomplete" | "observed" | "manual";

type TagTranslationStoredEntry = {
  tag: string;
  ja: string;
  source: TagTranslationSource;
  observedCount?: number;
  lastUsedAt?: string;
  pinned?: boolean;
};

type TagTranslationStorage = {
  entries: TagTranslationStoredEntry[];
  savedAt: string;
};

type FormState = {
  tag: string;
  ja: string;
  source: TagTranslationSource;
  pinned: boolean;
};

type RetranslateState = {
  phase: "idle" | "pending" | "error";
  error?: string;
};

const formatTimestamp = (value: string | null) => {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
};

const normalizeEntry = (entry: TagTranslationStoredEntry) => {
  const tag = entry.tag?.trim();
  const ja = entry.ja?.trim();
  if (!tag || !ja) return null;
  const source: TagTranslationSource =
    entry.source === "tagcomplete" || entry.source === "observed" || entry.source === "manual"
      ? entry.source
      : "observed";
  return {
    tag,
    ja,
    source,
    observedCount: typeof entry.observedCount === "number" ? entry.observedCount : undefined,
    lastUsedAt: typeof entry.lastUsedAt === "string" ? entry.lastUsedAt : undefined,
    pinned: entry.pinned === true
  };
};

export default function InternalsTranslationsPage() {
  const [entries, setEntries] = useState<TagTranslationStoredEntry[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>({
    tag: "",
    ja: "",
    source: "observed",
    pinned: false
  });
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const inFlightRef = useRef(new Map<string, Promise<void>>());
  const requestIdRef = useRef(new Map<string, number>());
  const [retranslateState, setRetranslateState] = useState<Record<string, RetranslateState>>({});

  useEffect(() => {
    let active = true;
    const load = async () => {
      const stored = await idbGet<TagTranslationStorage>(STORAGE_KEY);
      if (!active) return;
      if (stored?.entries && Array.isArray(stored.entries)) {
        setEntries(stored.entries);
        setSavedAt(typeof stored.savedAt === "string" ? stored.savedAt : null);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => {
      if (entry.tag.toLowerCase().includes(query)) return true;
      return entry.ja.toLowerCase().includes(query);
    });
  }, [entries, search]);

  const saveEntries = async (nextEntries: TagTranslationStoredEntry[], overrideSavedAt?: string) => {
    const nextSavedAt = overrideSavedAt ?? new Date().toISOString();
    setEntries(nextEntries);
    setSavedAt(nextSavedAt);
    const ok = await idbSet(STORAGE_KEY, { entries: nextEntries, savedAt: nextSavedAt });
    setMessage(ok ? "Saved" : "Save failed");
  };

  const resetForm = () => {
    setEditingIndex(null);
    setForm({ tag: "", ja: "", source: "observed", pinned: false });
  };

  const startEdit = (index: number) => {
    const entry = entries[index];
    setEditingIndex(index);
    setForm({
      tag: entry.tag,
      ja: entry.ja,
      source: entry.source,
      pinned: entry.pinned === true
    });
  };

  const handleSave = async () => {
    const tag = form.tag.trim();
    const ja = form.ja.trim();
    if (!tag || !ja) {
      setMessage("tag and ja are required");
      return;
    }
    const nextEntry: TagTranslationStoredEntry = {
      tag,
      ja,
      source: form.source,
      pinned: form.pinned,
      lastUsedAt: new Date().toISOString(),
      observedCount: entries[editingIndex ?? -1]?.observedCount
    };
    const nextEntries = [...entries];
    if (editingIndex !== null) {
      nextEntries[editingIndex] = nextEntry;
    } else {
      const existingIndex = entries.findIndex((entry) => entry.tag.toLowerCase() === tag.toLowerCase());
      if (existingIndex >= 0) {
        nextEntries[existingIndex] = {
          ...nextEntries[existingIndex],
          ...nextEntry,
          observedCount: nextEntries[existingIndex].observedCount
        };
      } else {
        nextEntries.push(nextEntry);
      }
    }
    await saveEntries(nextEntries);
    resetForm();
  };

  const handleDelete = async (index: number) => {
    const entry = entries[index];
    if (entry.pinned) {
      if (!window.confirm(`"${entry.tag}" is pinned. Delete anyway?`)) return;
    } else if (!window.confirm(`Delete translation "${entry.tag}"?`)) {
      return;
    }
    const nextEntries = entries.filter((_, idx) => idx !== index);
    await saveEntries(nextEntries);
  };

  const handleClear = async () => {
    if (!window.confirm("Clear all translations?")) return;
    await saveEntries([]);
  };

  const handleExport = () => {
    const payload: TagTranslationStorage = {
      entries,
      savedAt: savedAt ?? new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "translations.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as TagTranslationStorage;
      const rawEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const normalized: TagTranslationStoredEntry[] = [];
      const seen = new Set<string>();
      for (const entry of rawEntries) {
        const normalizedEntry = normalizeEntry(entry);
        if (!normalizedEntry) continue;
        const key = normalizedEntry.tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(normalizedEntry);
      }
      if (entries.length > 0 && !window.confirm("Import will overwrite existing translations. Continue?")) {
        return;
      }
      const nextSavedAt = typeof parsed?.savedAt === "string" ? parsed.savedAt : new Date().toISOString();
      await saveEntries(normalized, nextSavedAt);
      setMessage(`Imported ${normalized.length.toLocaleString()} entries`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Import failed");
    } finally {
      event.target.value = "";
    }
  };

  const setRowState = (tag: string, state: RetranslateState) => {
    setRetranslateState((prev) => ({ ...prev, [tag]: state }));
  };

  const handleRetranslate = (tag: string) => {
    if (inFlightRef.current.has(tag)) return;
    const nextRequestId = (requestIdRef.current.get(tag) ?? 0) + 1;
    requestIdRef.current.set(tag, nextRequestId);
    setRowState(tag, { phase: "pending" });

    let runPromise: Promise<void>;
    const execute = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
      try {
        const response = await fetch(`${API_BASE_URL}/api/translate/tags`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags: [tag], force: true }),
          cache: "no-store",
          signal: controller.signal
        });
        const text = await response.text();
        if (requestIdRef.current.get(tag) !== nextRequestId) return;
        if (!response.ok) {
          setRowState(tag, { phase: "error", error: `HTTP ${response.status}` });
          return;
        }
        let payload: any = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          setRowState(tag, { phase: "error", error: "Invalid response" });
          return;
        }
        if (!payload || payload.ok !== true || !payload.data || typeof payload.data.translations !== "object") {
          setRowState(tag, { phase: "error", error: payload?.error?.message || "Invalid response" });
          return;
        }
        const translated = payload.data.translations[tag];
        const ja = typeof translated === "string" && translated.trim() ? translated.trim() : tag;
        const index = entries.findIndex((entry) => entry.tag.toLowerCase() === tag.toLowerCase());
        if (index >= 0) {
          const nextEntries = [...entries];
          nextEntries[index] = {
            ...nextEntries[index],
            ja,
            lastUsedAt: new Date().toISOString()
          };
          await saveEntries(nextEntries);
        }
        setRowState(tag, { phase: "idle" });
      } catch (err) {
        if (requestIdRef.current.get(tag) !== nextRequestId) return;
        const message =
          err instanceof Error && err.name === "AbortError"
            ? "timeout"
            : err instanceof Error
              ? err.message
              : "translate failed";
        setRowState(tag, { phase: "error", error: message });
      } finally {
        clearTimeout(timeoutId);
        if (inFlightRef.current.get(tag) === runPromise) {
          inFlightRef.current.delete(tag);
        }
      }
    };

    runPromise = execute();
    inFlightRef.current.set(tag, runPromise);
  };

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Internals</p>
        <h1 className="text-2xl font-semibold">Translations Cache</h1>
        <p className="text-sm text-slate-400">IndexedDB key: {STORAGE_KEY}</p>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 shadow-lg shadow-black/40">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-300">
            <span className="mr-3">Entries: {entries.length.toLocaleString()}</span>
            <span>Saved: {formatTimestamp(savedAt)}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExport}
              className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
            >
              Export JSON
            </button>
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
            >
              Import JSON
            </button>
            <button
              type="button"
              onClick={handleClear}
              className="rounded-md border border-rose-500/60 px-3 py-1 text-xs text-rose-200 transition hover:border-rose-300 hover:text-rose-100"
            >
              Clear All
            </button>
            <input ref={importInputRef} type="file" accept="application/json" onChange={handleImport} hidden />
          </div>
        </div>
        {message && <p className="mt-2 text-xs text-slate-400">{message}</p>}
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 shadow-lg shadow-black/40">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-slate-400">Search</label>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full max-w-sm rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
            placeholder="tag / ja"
          />
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-separate border-spacing-y-2 text-sm">
            <thead className="text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 text-left">Tag</th>
                <th className="px-3 text-left">JA</th>
                <th className="px-3 text-left">Source</th>
                <th className="px-3 text-left">Pinned</th>
                <th className="px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                    No entries
                  </td>
                </tr>
              )}
              {filtered.map((entry) => {
                const index = entries.indexOf(entry);
                const rowState = retranslateState[entry.tag] ?? { phase: "idle" as const };
                return (
                  <tr key={`${entry.tag}-${index}`} className="rounded-lg bg-slate-900/60">
                    <td className="px-3 py-3 text-slate-100">{entry.tag}</td>
                    <td className="px-3 py-3 text-slate-200">{entry.ja}</td>
                    <td className="px-3 py-3 text-slate-300">{entry.source}</td>
                    <td className="px-3 py-3 text-slate-300">{entry.pinned ? "Yes" : "-"}</td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => startEdit(index)}
                          className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRetranslate(entry.tag)}
                          disabled={rowState.phase === "pending"}
                          className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                          title={rowState.phase === "error" ? rowState.error : "Re-translate"}
                        >
                          {rowState.phase === "pending" ? "Translating..." : "Re-translate"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(index)}
                          className="rounded-md border border-rose-500/60 px-3 py-1 text-xs text-rose-200 transition hover:border-rose-300 hover:text-rose-100"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 shadow-lg shadow-black/40">
        <h2 className="text-lg font-semibold">{editingIndex !== null ? "Edit Entry" : "Add Entry"}</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="space-y-1 text-xs text-slate-400">
            Tag
            <input
              value={form.tag}
              onChange={(event) => setForm((prev) => ({ ...prev, tag: event.target.value }))}
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-400">
            Japanese
            <input
              value={form.ja}
              onChange={(event) => setForm((prev) => ({ ...prev, ja: event.target.value }))}
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-400">
            Source
            <select
              value={form.source}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, source: event.target.value as TagTranslationSource }))
              }
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
            >
              <option value="tagcomplete">tagcomplete</option>
              <option value="observed">observed</option>
              <option value="manual">manual</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={form.pinned}
              onChange={(event) => setForm((prev) => ({ ...prev, pinned: event.target.checked }))}
              className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-emerald-400 focus:ring-emerald-400"
            />
            Pinned
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleSave}
            className="rounded-md border border-emerald-500/60 px-4 py-2 text-xs text-emerald-100 transition hover:border-emerald-400 hover:text-white"
          >
            Save
          </button>
          <button
            type="button"
            onClick={resetForm}
            className="rounded-md border border-slate-700 px-4 py-2 text-xs text-slate-200 transition hover:border-slate-500 hover:text-white"
          >
            Reset
          </button>
        </div>
      </section>
    </div>
  );
}
