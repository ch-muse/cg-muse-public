import { useState, type ChangeEvent } from "react";
import {
  buildTagDictionary,
  parseTagCsv,
  saveTagDictionary,
  type TagDictionary
} from "../../lib/tagDictionary.js";

type ImportPhase = "idle" | "loading" | "error" | "success";

type ImportState = {
  phase: ImportPhase;
  message: string | null;
  progress: string | null;
};

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

type TagDictionaryPanelProps = {
  dictionary: TagDictionary | null;
  onDictionaryChange: (dictionary: TagDictionary | null) => void;
};

export default function TagDictionaryPanel({ dictionary, onDictionaryChange }: TagDictionaryPanelProps) {
  const [importState, setImportState] = useState<ImportState>({
    phase: "idle",
    message: null,
    progress: null
  });

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setImportState({
        phase: "error",
        message: "10MB を超えるため読み込みを中止しました。",
        progress: null
      });
      event.target.value = "";
      return;
    }

    setImportState({ phase: "loading", message: "Importing...", progress: null });
    try {
      const entries = await parseTagCsv(file, {
        onProgress: (progress) => {
          setImportState((prev) => ({
            ...prev,
            progress: `${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()}`
          }));
        }
      });
      const dictionary = buildTagDictionary(entries);
      const stored = await saveTagDictionary(entries);
      onDictionaryChange(dictionary);
      setImportState({
        phase: stored ? "success" : "error",
        message: stored
          ? `Imported ${entries.length.toLocaleString()} tags`
          : "Imported, but storage failed",
        progress: null
      });
    } catch (err) {
      setImportState({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
        progress: null
      });
    } finally {
      event.target.value = "";
    }
  };

  const loadedCount = dictionary?.entries.length ?? 0;

  return (
    <details className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 shadow-lg shadow-black/40">
      <summary className="cursor-pointer text-lg font-semibold">Tag Dictionary</summary>
      <div className="mt-4 space-y-3 text-sm text-slate-300">
        <div className="space-y-1">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={handleImport}
            className="block w-full text-sm text-slate-200 file:mr-3 file:rounded-md file:border file:border-slate-700 file:bg-slate-900 file:px-3 file:py-2 file:text-xs file:text-slate-200 file:transition hover:file:border-emerald-400/60 hover:file:text-white"
          />
          <p className="text-xs text-slate-500">format: tag,type,count,aliases (aliases optional)</p>
        </div>

        <div className="text-xs text-slate-400">
          {loadedCount > 0 ? `Loaded tags: ${loadedCount.toLocaleString()}` : "No dictionary loaded"}
        </div>

        {importState.phase === "loading" && (
          <div className="text-xs text-slate-400">
            <span>Importing...</span>
            {importState.progress && <span className="ml-2">{importState.progress}</span>}
          </div>
        )}
        {importState.phase === "error" && (
          <div className="text-xs text-rose-300">Error: {importState.message ?? "-"}</div>
        )}
        {importState.phase === "success" && (
          <div className="text-xs text-emerald-300">{importState.message ?? "Imported"}</div>
        )}
      </div>
    </details>
  );
}
