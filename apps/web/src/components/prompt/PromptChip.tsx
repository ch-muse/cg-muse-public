import { type KeyboardEvent, type FocusEvent, type ChangeEvent, type HTMLAttributes, type ReactNode } from "react";
import { RefreshCcw, X } from "lucide-react";

type TranslationEntry = {
  status: "pending" | "done" | "error";
  ja?: string;
  error?: string;
};

type PromptChipProps = {
  value: string;
  isEditing: boolean;
  editValue: string;
  onEditChange: (value: string) => void;
  onEditSubmit: () => void;
  onEditCancel: () => void;
  onStartEdit: () => void;
  onRemove: () => void;
  translation?: TranslationEntry;
  onRetranslate?: () => void;
  rootProps?: HTMLAttributes<HTMLDivElement>;
  menu?: ReactNode;
};

export default function PromptChip({
  value,
  isEditing,
  editValue,
  onEditChange,
  onEditSubmit,
  onEditCancel,
  onStartEdit,
  onRemove,
  translation,
  onRetranslate,
  rootProps,
  menu
}: PromptChipProps) {
  if (isEditing) {
    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onEditSubmit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        onEditCancel();
      }
    };
    const handleBlur = (_event: FocusEvent<HTMLInputElement>) => {
      onEditSubmit();
    };
    const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
      onEditChange(event.target.value);
    };
    return (
      <div className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-1">
        <input
          value={editValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onPointerDown={(event) => event.stopPropagation()}
          autoFocus
          className="w-40 bg-transparent text-sm text-slate-100 focus:outline-none"
        />
        <button
          type="button"
          onClick={onEditCancel}
          className="text-xs text-slate-400 transition hover:text-slate-100"
        >
          Esc
        </button>
      </div>
    );
  }

  const translationLabel =
    translation?.status === "done"
      ? translation.ja
      : translation?.status === "pending"
        ? "..."
        : translation?.status === "error"
          ? "!"
          : null;
  const translationTooltip =
    translation?.status === "error" ? translation.error ?? "翻訳失敗" : translationLabel ?? null;
  const translationClass =
    translation?.status === "error"
      ? "text-xs text-rose-300"
      : translation?.status === "pending"
        ? "text-xs text-slate-500"
        : "text-xs text-slate-400";

  return (
    <div
      {...rootProps}
      className={`group flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 ${
        rootProps?.className ?? ""
      }`}
    >
      <button
        type="button"
        onClick={onStartEdit}
        title={translationTooltip ?? undefined}
        className="min-w-0 text-left"
      >
        <span className="block max-w-[14rem] truncate text-sm text-slate-100">{value}</span>
        {translationLabel && <span className={translationClass}>{translationLabel}</span>}
      </button>
      <div className="flex items-center gap-1">
        {menu}
        {onRetranslate && (
          <button
            type="button"
            onClick={onRetranslate}
            onPointerDown={(event) => event.stopPropagation()}
            title="Re-translate token"
            aria-label="Re-translate token"
            disabled={translation?.status === "pending"}
            className="flex h-8 w-8 min-h-8 min-w-8 items-center justify-center rounded-full text-slate-300 opacity-0 transition hover:bg-slate-700/40 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/60 disabled:cursor-not-allowed disabled:opacity-30 group-hover:opacity-100"
          >
            <RefreshCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          onPointerDown={(event) => event.stopPropagation()}
          title="Remove token"
          aria-label="Remove token"
          className="flex h-8 w-8 min-h-8 min-w-8 items-center justify-center rounded-full text-rose-300 transition hover:bg-rose-500/10 hover:text-rose-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/50"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
