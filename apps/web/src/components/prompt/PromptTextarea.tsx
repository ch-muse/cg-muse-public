import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { API_BASE_URL } from "../../lib/api.js";

type TagSuggestion = {
  tag: string;
  ja?: string;
  count?: number;
  observedCount?: number;
  source: "dictionary" | "persistent";
};

type PromptTextareaProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  suggestionLimit?: number;
};

const SUGGEST_DEBOUNCE_MS = 260;
const SUGGEST_TIMEOUT_MS = 4000;
const JAPANESE_QUERY_PATTERN = /[\u3040-\u30FF\u4E00-\u9FFF]/;

const findTokenRange = (value: string, cursor: number) => {
  const clamped = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, clamped);
  const after = value.slice(clamped);
  const startIndex = before.lastIndexOf(",");
  const endIndex = after.indexOf(",");
  const start = startIndex === -1 ? 0 : startIndex + 1;
  const end = endIndex === -1 ? value.length : clamped + endIndex;
  return { start, end };
};

const extractTokenAtCursor = (value: string, cursor: number) => {
  const range = findTokenRange(value, cursor);
  const token = value.slice(range.start, range.end).trim();
  return { token, range };
};

const applyTokenInsertion = (value: string, range: { start: number; end: number }, tag: string) => {
  const before = value.slice(0, range.start);
  const after = value.slice(range.end);
  const beforeTrim = before.trimEnd();
  let afterTrim = after.trimStart();
  if (afterTrim.startsWith(",")) {
    afterTrim = afterTrim.replace(/^,\s*/, "");
  }
  const needsLeadingComma = beforeTrim.length > 0 && !beforeTrim.endsWith(",");
  const leading = needsLeadingComma ? ", " : beforeTrim.length > 0 ? " " : "";
  const trailing = ", ";
  const nextValue = `${beforeTrim}${leading}${tag}${trailing}${afterTrim}`;
  const cursor = beforeTrim.length + leading.length + tag.length + trailing.length;
  return { nextValue, cursor };
};

export default function PromptTextarea({
  value,
  onChange,
  placeholder,
  rows = 3,
  className,
  suggestionLimit = 20
}: PromptTextareaProps) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestAbortRef = useRef<AbortController | null>(null);
  const suggestRequestIdRef = useRef(0);
  const lastTokenRef = useRef("");
  const lastValueRef = useRef(value);
  const focusRef = useRef(false);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (suggestTimerRef.current) {
        clearTimeout(suggestTimerRef.current);
      }
      if (suggestAbortRef.current) {
        suggestAbortRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    if (lastValueRef.current !== value && !focusRef.current) {
      lastTokenRef.current = "";
      setQuery("");
      setSuggestions([]);
      setSuggestOpen(false);
    }
    lastValueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (suggestTimerRef.current) {
      clearTimeout(suggestTimerRef.current);
    }
    const trimmed = query.trim();
    if (!trimmed) {
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
      const isJapaneseQuery = JAPANESE_QUERY_PATTERN.test(trimmed);
      const params = new URLSearchParams({ q: trimmed, limit: String(limit) });
      const endpoint = isJapaneseQuery ? "/api/translate/persistent/search" : "/api/tags/dictionary";

      const run = async () => {
        let responseText = "";
        try {
          const response = await fetch(`${API_BASE_URL}${endpoint}?${params.toString()}`, {
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
          if (!payload || payload.ok !== true || !payload.data) {
            setSuggestions([]);
            setSuggestOpen(false);
            return;
          }
          const results: TagSuggestion[] = [];
          if (isJapaneseQuery) {
            if (!Array.isArray(payload.data.results)) {
              setSuggestions([]);
              setSuggestOpen(false);
              return;
            }
            for (const item of payload.data.results as any[]) {
              if (!item || typeof item.tag !== "string" || typeof item.ja !== "string") continue;
              results.push({
                tag: item.tag,
                ja: item.ja,
                observedCount: typeof item.observedCount === "number" ? item.observedCount : undefined,
                source: "persistent"
              });
            }
          } else {
            if (!Array.isArray(payload.data.items)) {
              setSuggestions([]);
              setSuggestOpen(false);
              return;
            }
            for (const item of payload.data.items as any[]) {
              if (!item || typeof item.tag !== "string") continue;
              results.push({
                tag: item.tag,
                ja: typeof item.ja === "string" ? item.ja : undefined,
                count: typeof item.count === "number" ? item.count : undefined,
                source: "dictionary"
              });
            }
          }
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
  }, [query, suggestionLimit]);

  const updateQueryFromCursor = (nextValue: string, cursor: number) => {
    const { token } = extractTokenAtCursor(nextValue, cursor);
    if (token === lastTokenRef.current) return;
    lastTokenRef.current = token;
    setQuery(token);
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    onChange(nextValue);
    const cursor = event.target.selectionStart ?? nextValue.length;
    updateQueryFromCursor(nextValue, cursor);
  };

  const handleCursorUpdate = () => {
    const el = textareaRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? el.value.length;
    updateQueryFromCursor(el.value, cursor);
  };

  const handleSelectSuggestion = (tag: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? el.value.length;
    const range = extractTokenAtCursor(el.value, cursor).range;
    const { nextValue, cursor: nextCursor } = applyTokenInsertion(el.value, range, tag);
    onChange(nextValue);
    setQuery("");
    setSuggestions([]);
    setSuggestOpen(false);
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && suggestOpen && suggestions.length > 0) {
      event.preventDefault();
      handleSelectSuggestion(suggestions[0].tag);
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={handleCursorUpdate}
        onClick={handleCursorUpdate}
        onFocus={() => {
          focusRef.current = true;
          handleCursorUpdate();
          if (suggestions.length > 0) setSuggestOpen(true);
        }}
        onBlur={() => {
          focusRef.current = false;
          setTimeout(() => setSuggestOpen(false), 120);
        }}
        rows={rows}
        className={className}
        placeholder={placeholder}
      />
      {suggestOpen && suggestions.length > 0 && (
        <div className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-md border border-slate-800 bg-slate-950 text-xs text-slate-200 shadow-lg">
          {suggestions.map((item) => (
            <button
              key={item.tag}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => handleSelectSuggestion(item.tag)}
              className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left transition hover:bg-slate-800"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.tag}</span>
                {item.ja && <span className="block truncate text-[11px] text-slate-500">{item.ja}</span>}
              </span>
              {typeof item.count === "number" && (
                <span className="text-[11px] text-slate-500">{item.count.toLocaleString()}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
