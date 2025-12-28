import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "../../lib/api.js";

type GallerySource = {
  id: string;
  name: string;
  root_path: string;
  enabled: boolean;
  recursive: boolean;
  include_glob: string | null;
  last_scan_at: string | null;
  last_error: string | null;
  created_at: string;
};

type SourceForm = {
  name: string;
  rootPath: string;
  enabled: boolean;
  recursive: boolean;
  includeGlob: string;
};

type DebugState = {
  phase: "idle" | "fetching" | "success" | "error";
  lastUpdatedAt: string | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  lastRawText: string | null;
};

const FETCH_TIMEOUT_MS = 8000;
const DEBUG_TEXT_LIMIT = 600;

const emptyForm: SourceForm = {
  name: "",
  rootPath: "",
  enabled: true,
  recursive: true,
  includeGlob: ""
};

const emptyDebug: DebugState = {
  phase: "idle",
  lastUpdatedAt: null,
  lastHttpStatus: null,
  lastError: null,
  lastRawText: null
};

const truncateText = (text: string, limit = DEBUG_TEXT_LIMIT) =>
  text.length > limit ? `${text.slice(0, limit)}...` : text;

const formatTimestamp = (value: string | null) => {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
};

export default function InternalsGallerySourcesPage() {
  const [sources, setSources] = useState<GallerySource[]>([]);
  const [form, setForm] = useState<SourceForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [debug, setDebug] = useState<DebugState>(emptyDebug);
  const listAbortRef = useRef<AbortController | null>(null);
  const listRequestIdRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const scanInFlightRef = useRef<Set<string>>(new Set());
  const deleteInFlightRef = useRef<Set<string>>(new Set());

  const fetchSources = useCallback(async () => {
    if (listAbortRef.current) {
      listAbortRef.current.abort();
    }
    const requestId = listRequestIdRef.current + 1;
    listRequestIdRef.current = requestId;
    const controller = new AbortController();
    listAbortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    setDebug((prev) => ({
      ...prev,
      phase: "fetching",
      lastError: null,
      lastHttpStatus: null,
      lastRawText: null
    }));

    let rawText = "";
    try {
      const response = await fetch(`${API_BASE_URL}/api/gallery/sources`, {
        cache: "no-store",
        signal: controller.signal
      });
      rawText = await response.text();
      if (listRequestIdRef.current !== requestId) return;
      setDebug((prev) => ({
        ...prev,
        lastHttpStatus: response.status,
        lastRawText: rawText ? truncateText(rawText) : null
      }));
      if (!response.ok) {
        setDebug((prev) => ({ ...prev, phase: "error", lastError: `HTTP ${response.status}` }));
        return;
      }
      const payload = rawText ? (JSON.parse(rawText) as any) : null;
      if (!payload || payload.ok !== true || !Array.isArray(payload.data?.sources)) {
        setDebug((prev) => ({ ...prev, phase: "error", lastError: payload?.error?.message || "Invalid response" }));
        return;
      }
      setSources(payload.data.sources as GallerySource[]);
      setDebug((prev) => ({ ...prev, phase: "success", lastUpdatedAt: new Date().toISOString() }));
    } catch (err) {
      if (listRequestIdRef.current !== requestId) return;
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : err instanceof Error
            ? err.message
            : "fetch failed";
      setDebug((prev) => ({ ...prev, phase: "error", lastError: message }));
    } finally {
      clearTimeout(timeoutId);
    }
  }, []);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
  };

  const handleEdit = (source: GallerySource) => {
    setEditingId(source.id);
    setForm({
      name: source.name,
      rootPath: source.root_path,
      enabled: source.enabled,
      recursive: source.recursive,
      includeGlob: source.include_glob ?? ""
    });
  };

  const handleSave = async () => {
    if (saveInFlightRef.current) return;
    if (!form.name.trim() || !form.rootPath.trim()) {
      setMessage("name と rootPath は必須です。");
      return;
    }
    saveInFlightRef.current = true;
    setMessage(null);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const body = JSON.stringify({
        name: form.name.trim(),
        rootPath: form.rootPath.trim(),
        enabled: form.enabled,
        recursive: form.recursive,
        includeGlob: form.includeGlob.trim() || undefined
      });
      const endpoint = editingId ? `/api/gallery/sources/${editingId}` : "/api/gallery/sources";
      const method = editingId ? "PUT" : "POST";
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body,
        cache: "no-store",
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        setMessage(`HTTP ${response.status}`);
        return;
      }
      const payload = text ? (JSON.parse(text) as any) : null;
      if (!payload || payload.ok !== true) {
        setMessage(payload?.error?.message || "Save failed");
        return;
      }
      resetForm();
      setMessage("保存しました。");
      fetchSources();
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : err instanceof Error
            ? err.message
            : "save failed";
      setMessage(message);
    } finally {
      clearTimeout(timeoutId);
      saveInFlightRef.current = false;
    }
  };

  const handleDelete = async (source: GallerySource) => {
    if (deleteInFlightRef.current.has(source.id)) return;
    if (!window.confirm(`削除しますか？: ${source.name}`)) return;
    deleteInFlightRef.current.add(source.id);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE_URL}/api/gallery/sources/${source.id}`, {
        method: "DELETE",
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) {
        setMessage(`HTTP ${response.status}`);
        return;
      }
      setMessage("削除しました。");
      fetchSources();
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : err instanceof Error
            ? err.message
            : "delete failed";
      setMessage(message);
    } finally {
      clearTimeout(timeoutId);
      deleteInFlightRef.current.delete(source.id);
    }
  };

  const handleScan = async (source: GallerySource) => {
    if (scanInFlightRef.current.has(source.id)) return;
    scanInFlightRef.current.add(source.id);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE_URL}/api/gallery/sources/${source.id}/scan`, {
        method: "POST",
        cache: "no-store",
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        setMessage(`HTTP ${response.status}`);
        return;
      }
      const payload = text ? (JSON.parse(text) as any) : null;
      if (!payload || payload.ok !== true) {
        setMessage(payload?.error?.message || "scan failed");
        return;
      }
      const result = payload.data ?? {};
      setMessage(`scan: imported ${result.imported ?? 0}, skipped ${result.skipped ?? 0}, errors ${result.errors ?? 0}`);
      fetchSources();
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : err instanceof Error
            ? err.message
            : "scan failed";
      setMessage(message);
    } finally {
      clearTimeout(timeoutId);
      scanInFlightRef.current.delete(source.id);
    }
  };

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm uppercase tracking-[0.25em] text-slate-400">Internals</p>
        <h1 className="text-3xl font-semibold">Gallery Sources</h1>
        <p className="text-sm text-slate-400">自動取り込みの対象フォルダを管理します。</p>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 shadow-lg shadow-black/40">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{editingId ? "Edit Source" : "Add Source"}</h2>
          <button
            type="button"
            onClick={fetchSources}
            className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:border-emerald-400/60 hover:text-white"
          >
            Refresh
          </button>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="space-y-1 text-xs text-slate-400">
            Name
            <input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-400">
            Root Path
            <input
              value={form.rootPath}
              onChange={(event) => setForm((prev) => ({ ...prev, rootPath: event.target.value }))}
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
              placeholder="C:\\path\\to\\gallery"
            />
          </label>
          <label className="space-y-1 text-xs text-slate-400">
            Include (glob)
            <input
              value={form.includeGlob}
              onChange={(event) => setForm((prev) => ({ ...prev, includeGlob: event.target.value }))}
              className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
              placeholder=".png;.jpg"
            />
          </label>
          <div className="flex flex-wrap items-center gap-4 pt-6 text-sm text-slate-300">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm((prev) => ({ ...prev, enabled: event.target.checked }))}
                className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-emerald-400 focus:ring-emerald-400"
              />
              Enabled
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.recursive}
                onChange={(event) => setForm((prev) => ({ ...prev, recursive: event.target.checked }))}
                className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-emerald-400 focus:ring-emerald-400"
              />
              Recursive
            </label>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            className="rounded-md border border-emerald-500/60 px-4 py-2 text-xs text-emerald-100 transition hover:border-emerald-400 hover:text-white"
          >
            {editingId ? "Update" : "Add"}
          </button>
          <button
            type="button"
            onClick={resetForm}
            className="rounded-md border border-slate-700 px-4 py-2 text-xs text-slate-200 transition hover:border-slate-400 hover:text-white"
          >
            Clear
          </button>
          {message && <span className="text-xs text-slate-400">{message}</span>}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 shadow-lg shadow-black/40">
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-y-2 text-sm">
            <thead className="text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 text-left">Name</th>
                <th className="px-3 text-left">Root</th>
                <th className="px-3 text-left">Flags</th>
                <th className="px-3 text-left">Include</th>
                <th className="px-3 text-left">Last Scan</th>
                <th className="px-3 text-left">Last Error</th>
                <th className="px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sources.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-slate-500">
                    No sources
                  </td>
                </tr>
              )}
              {sources.map((source) => (
                <tr key={source.id} className="rounded-lg bg-slate-900/60">
                  <td className="px-3 py-3 text-slate-100">{source.name}</td>
                  <td className="px-3 py-3 text-slate-300">{source.root_path}</td>
                  <td className="px-3 py-3 text-slate-300">
                    {source.enabled ? "enabled" : "disabled"} / {source.recursive ? "recursive" : "flat"}
                  </td>
                  <td className="px-3 py-3 text-slate-400">{source.include_glob ?? "-"}</td>
                  <td className="px-3 py-3 text-slate-400">{formatTimestamp(source.last_scan_at)}</td>
                  <td className="px-3 py-3 text-rose-300">{source.last_error ?? "-"}</td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handleScan(source)}
                        className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
                      >
                        Scan
                      </button>
                      <button
                        type="button"
                        onClick={() => handleEdit(source)}
                        className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(source)}
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

      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 shadow-lg shadow-black/40">
        <h2 className="text-sm font-semibold text-slate-200">Debug</h2>
        <div className="mt-3 grid gap-3 text-xs text-slate-200">
          <div className="flex flex-wrap gap-4">
            <span>phase: {debug.phase}</span>
            <span>lastUpdatedAt: {debug.lastUpdatedAt ?? "-"}</span>
            <span>lastHttpStatus: {debug.lastHttpStatus ?? "-"}</span>
          </div>
          <div className="flex flex-wrap gap-4">
            <span>lastError: {debug.lastError ?? "-"}</span>
          </div>
          <div>
            <p className="text-xs text-slate-400">lastRawText (truncated)</p>
            <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-300">
              {debug.lastRawText ?? "-"}
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
}
