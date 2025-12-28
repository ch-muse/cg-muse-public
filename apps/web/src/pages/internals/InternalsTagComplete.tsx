import { useMemo, useRef, useState, useEffect, type ChangeEvent } from "react";
import { idbGet, idbSet } from "../../lib/indexedDb.js";
import type { TagDictionaryStoredEntry } from "../../lib/tagDictionary.js";

const STORAGE_KEY = "muse.tagDictionary.v1";

type TagDictionaryStorage = {
  entries: TagDictionaryStoredEntry[];
  savedAt: string;
};

type FormState = {
  tag: string;
  type: string;
  count: string;
  aliases: string;
};

const formatTimestamp = (value: string | null) => {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
};

const parseAliases = (value: string) =>
  value
    .split(/[|,]/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const normalizeEntry = (entry: TagDictionaryStoredEntry) => {
  const tag = entry.tag.trim();
  if (!tag) return null;
  const type = entry.type?.trim() || undefined;
  const count =
    typeof entry.count === "number" && Number.isFinite(entry.count) ? Math.trunc(entry.count) : undefined;
  const aliases = Array.isArray(entry.aliases) ? entry.aliases.map((alias) => alias.trim()).filter(Boolean) : [];
  return { tag, type, count, aliases };
};

export default function InternalsTagCompletePage() {
  const [entries, setEntries] = useState<TagDictionaryStoredEntry[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>({
    tag: "",
    type: "",
    count: "",
    aliases: ""
  });
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const stored = await idbGet<TagDictionaryStorage>(STORAGE_KEY);
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
      if (entry.type && entry.type.toLowerCase().includes(query)) return true;
      return entry.aliases.some((alias) => alias.toLowerCase().includes(query));
    });
  }, [entries, search]);

  const saveEntries = async (nextEntries: TagDictionaryStoredEntry[], overrideSavedAt?: string) => {
    const nextSavedAt = overrideSavedAt ?? new Date().toISOString();
    setEntries(nextEntries);
    setSavedAt(nextSavedAt);
    const ok = await idbSet(STORAGE_KEY, { entries: nextEntries, savedAt: nextSavedAt });
    setMessage(ok ? "Saved" : "Save failed");
  };

  const resetForm = () => {
    setEditingIndex(null);
    setForm({ tag: "", type: "", count: "", aliases: "" });
  };

  const startEdit = (index: number) => {
    const entry = entries[index];
    setEditingIndex(index);
    setForm({
      tag: entry.tag,
      type: entry.type ?? "",
      count: entry.count !== undefined ? String(entry.count) : "",
      aliases: entry.aliases.join(", ")
    });
  };

  const handleSave = async () => {
    const tag = form.tag.trim();
    if (!tag) {
      setMessage("tag is required");
      return;
    }
    const type = form.type.trim() || undefined;
    const countValue = Number(form.count.trim());
    const count = Number.isFinite(countValue) ? Math.trunc(countValue) : undefined;
    const aliases = parseAliases(form.aliases);
    const nextEntry: TagDictionaryStoredEntry = { tag, type, count, aliases };

    const nextEntries = [...entries];
    if (editingIndex !== null) {
      nextEntries[editingIndex] = nextEntry;
    } else {
      const existingIndex = entries.findIndex((entry) => entry.tag.toLowerCase() === tag.toLowerCase());
      if (existingIndex >= 0) {
        nextEntries[existingIndex] = nextEntry;
      } else {
        nextEntries.push(nextEntry);
      }
    }
    await saveEntries(nextEntries);
    resetForm();
  };

  const handleDelete = async (index: number) => {
    const entry = entries[index];
    if (!window.confirm(`Delete tag "${entry.tag}"?`)) return;
    const nextEntries = entries.filter((_, idx) => idx !== index);
    await saveEntries(nextEntries);
  };

  const handleClear = async () => {
    if (!window.confirm("Clear all tagcomplete entries?")) return;
    await saveEntries([]);
  };

  const handleExport = () => {
    const payload: TagDictionaryStorage = {
      entries,
      savedAt: savedAt ?? new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tagcomplete.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as TagDictionaryStorage;
      const rawEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const normalized: TagDictionaryStoredEntry[] = [];
      const seen = new Set<string>();
      for (const entry of rawEntries) {
        const normalizedEntry = normalizeEntry(entry);
        if (!normalizedEntry) continue;
        const key = normalizedEntry.tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(normalizedEntry);
      }
      if (entries.length > 0 && !window.confirm("Import will overwrite existing entries. Continue?")) {
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

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Internals</p>
        <h1 className="text-2xl font-semibold">TagComplete Dictionary</h1>
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
            placeholder="tag / type / alias"
          />
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-separate border-spacing-y-2 text-sm">
            <thead className="text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 text-left">Tag</th>
                <th className="px-3 text-left">Type</th>
                <th className="px-3 text-left">Count</th>
                <th className="px-3 text-left">Aliases</th>
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
                return (
                  <tr key={`${entry.tag}-${index}`} className="rounded-lg bg-slate-900/60">
                    <td className="px-3 py-3 text-slate-100">{entry.tag}</td>
                    <td className="px-3 py-3 text-slate-300">{entry.type ?? "-"}</td>
                    <td className="px-3 py-3 text-slate-300">{entry.count ?? "-"}</td>
                    <td className="px-3 py-3 text-slate-400">{entry.aliases.join(", ") || "-"}</td>
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
            Type
            <input
              value={form.type}
              onChange={(event) => setForm((prev) => ({ ...prev, type: event.target.value }))}
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-400">
            Count
            <input
              value={form.count}
              onChange={(event) => setForm((prev) => ({ ...prev, count: event.target.value }))}
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-400">
            Aliases (comma/pipe)
            <input
              value={form.aliases}
              onChange={(event) => setForm((prev) => ({ ...prev, aliases: event.target.value }))}
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 focus:border-emerald-400 focus:outline-none"
            />
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
