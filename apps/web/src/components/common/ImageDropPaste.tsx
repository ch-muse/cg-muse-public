import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode
} from "react";

type ImageDropPasteProps = {
  label?: string;
  valueFile?: File | null;
  onChangeFile: (file: File | null) => void;
  accept?: string;
  disabled?: boolean;
  maxSizeBytes?: number;
  helpText?: string;
  actions?: ReactNode;
};

const DEFAULT_MAX_SIZE_BYTES = 20 * 1024 * 1024;
const ARM_TIMEOUT_MS = 10000;

const formatBytes = (value: number) => {
  if (!Number.isFinite(value)) return "-";
  if (value < 1024) return `${value} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
};

const isFileAccepted = (file: File, accept: string) => {
  const tokens = accept
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return true;

  return tokens.some((token) => {
    if (token === "*/*") return true;
    if (token.endsWith("/*")) {
      const prefix = token.slice(0, -1);
      return file.type.startsWith(prefix);
    }
    if (token.startsWith(".")) {
      return file.name.toLowerCase().endsWith(token.toLowerCase());
    }
    return file.type === token;
  });
};

export default function ImageDropPaste({
  label,
  valueFile,
  onChangeFile,
  accept = "image/*",
  disabled = false,
  maxSizeBytes = DEFAULT_MAX_SIZE_BYTES,
  helpText,
  actions
}: ImageDropPasteProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [isArmed, setIsArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!valueFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(valueFile);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [valueFile]);

  useEffect(() => {
    if (!isArmed) return;
    timerRef.current = window.setTimeout(() => {
      setIsArmed(false);
    }, ARM_TIMEOUT_MS);
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isArmed]);

  useEffect(() => {
    if (!isArmed || disabled) return;
    const handlePaste = (event: ClipboardEvent) => {
      if (!isArmed || disabled) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (!file) continue;
        event.preventDefault();
        applyFile(file);
        setIsArmed(false);
        return;
      }
    };
    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("paste", handlePaste);
    };
  }, [isArmed, disabled, accept, maxSizeBytes]);

  const setArmed = () => {
    if (disabled) return;
    setIsArmed(true);
  };

  const applyFile = (file: File | null) => {
    if (!file) {
      setError(null);
      onChangeFile(null);
      return;
    }
    if (accept && !isFileAccepted(file, accept)) {
      setError("対応していないファイル形式です。");
      return;
    }
    if (maxSizeBytes && file.size > maxSizeBytes) {
      setError(`ファイルサイズが上限(${formatBytes(maxSizeBytes)})を超えています。`);
      return;
    }
    setError(null);
    onChangeFile(file);
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    applyFile(file);
  };

  const handleClick = () => {
    if (disabled) return;
    setArmed();
    inputRef.current?.click();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleClick();
    }
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsArmed(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled) return;
    setIsDragActive(false);
    const file = event.dataTransfer.files?.[0] ?? null;
    applyFile(file);
  };

  const highlight = isDragActive || isArmed;

  return (
    <div className="space-y-2">
      {label && <div className="text-sm text-slate-300">{label}</div>}
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={handleClick}
        onFocus={setArmed}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onDragEnter={(event) => {
          event.preventDefault();
          if (disabled) return;
          setIsDragActive(true);
          setArmed();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (disabled) return;
          setIsDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          if (disabled) return;
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setIsDragActive(false);
        }}
        onDrop={handleDrop}
        className={`rounded-lg border border-dashed px-4 py-3 text-left transition ${
          highlight ? "border-emerald-400/70 bg-emerald-500/10" : "border-slate-700 bg-slate-950/40"
        } ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          disabled={disabled}
          onChange={handleInputChange}
          className="hidden"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-xs text-slate-200">ドラッグ&ドロップ / クリックして選択</p>
            <p className="text-[11px] text-slate-500">
              {isArmed ? "貼り付け受付中（Ctrl+V）" : "クリックで貼り付け待機"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {actions}
            {valueFile && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  applyFile(null);
                }}
                className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-emerald-400/60 hover:text-white"
              >
                クリア
              </button>
            )}
          </div>
        </div>
        {previewUrl ? (
          <div className="mt-3 inline-flex max-w-xs overflow-hidden rounded-md border border-slate-800 bg-slate-900/60 p-2">
            <img src={previewUrl} alt="preview" className="h-24 w-auto rounded object-contain" />
          </div>
        ) : (
          <div className="mt-2 text-[11px] text-slate-500">画像を選択するとプレビューします。</div>
        )}
        {valueFile && (
          <div className="mt-2 text-[11px] text-slate-400">
            {valueFile.name} ({formatBytes(valueFile.size)})
          </div>
        )}
        {helpText && <div className="mt-2 text-[11px] text-slate-500">{helpText}</div>}
        {error && <div className="mt-2 text-[11px] text-rose-300">{error}</div>}
      </div>
    </div>
  );
}
