import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { API_BASE_URL } from "../lib/api.js";
import PromptComposer, { normalizeTokenKey } from "../components/prompt/PromptComposer.js";
import TagDictionaryPanel from "../components/prompt/TagDictionaryPanel.js";
import type { TagDictionary } from "../lib/tagDictionary.js";
import type { Lora } from "../types.js";

type ComfyOptionsData = {
  ckptNames: string[];
  loraNames: string[];
  controlnetModelNames: string[];
  preprocessorNames: string[];
  partialErrors: { nodeClass: string; message: string; details?: unknown }[];
};

type ComfyDefaults = {
  efficientLoaderDefaults: {
    ckptName: string;
    positive: string;
    negative: string;
    width: number;
    height: number;
  };
  loraDefaults: { name: string; weight: number }[];
  controlnetDefaults: {
    modelName: string;
    preprocessor: string;
    strength: number;
    enabled: boolean;
    imageName: string | null;
  };
  ksamplerDefaults: {
    steps: number;
    cfg: number;
    sampler_name: string;
    scheduler: string;
    denoise: number;
    seed: number;
  };
};

type ComfyImage2iDefaults = {
  ksamplerDenoiseDefault: number;
};

type OptionsPhase = "idle" | "fetching" | "success" | "error";

type OptionsDebugState = {
  attempt: number;
  phase: OptionsPhase;
  lastUpdatedAt: string | null;
  lastError: string | null;
  lastRequestUrl: string | null;
  lastHttpStatus: number | null;
  lastRawText: string | null;
};

type SubmitPhase = "idle" | "submitting" | "success" | "error";

type SubmitDebugState = {
  phase: SubmitPhase;
  lastError: string | null;
  lastHttpStatus: number | null;
  lastRawText: string | null;
  lastRunId: string | null;
  lastPromptId: string | null;
};

type LoraRow = {
  id: number;
  name: string;
  weight: string;
};

type ComfyRun = {
  id: string;
  status?: string | null;
  prompt_id?: string | null;
  request_json?: unknown;
  history_json?: unknown;
  error_message?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  [key: string]: unknown;
};

type RunsPhase = "idle" | "fetching" | "success" | "error";

type RunsDebugState = {
  attempt: number;
  phase: RunsPhase;
  lastUpdatedAt: string | null;
  lastError: string | null;
  lastHttpStatus: number | null;
  lastRawText: string | null;
};

type RunOutput = {
  filename: string;
  subfolder?: string | null;
  type?: string | null;
};

type GalleryItemSummary = {
  id: string;
  filename?: string | null;
  ckpt_name?: string | null;
  positive?: string | null;
  negative?: string | null;
  width?: number | null;
  height?: number | null;
  lora_names?: string[] | null;
  viewUrl?: string | null;
};

const OPTIONS_TIMEOUT_MS = 8000;
const RUN_SUBMIT_TIMEOUT_MS = 12000;
const RUNS_POLL_INTERVAL_MS = {
  fast: 2500,
  medium: 5000,
  slow: 10000
} as const;
const RUNS_FETCH_TIMEOUT_MS = 8000;
const RUNS_REFRESH_TIMEOUT_MS = 8000;
const RUNS_DELETE_TIMEOUT_MS = 8000;
const REHYDRATE_TIMEOUT_MS = 8000;
const LORA_LIBRARY_TIMEOUT_MS = 8000;
const LORA_RESULT_LIMIT = 80;

const emptyOptions: ComfyOptionsData = {
  ckptNames: [],
  loraNames: [],
  controlnetModelNames: [],
  preprocessorNames: [],
  partialErrors: []
};

const truncateText = (value: string, limit = 1200) => {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
};

const normalizeStringArray = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const normalizeLoraFileKey = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const normalized = trimmed.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  return base.trim().toLowerCase();
};

const splitPromptTokens = (value: string) =>
  value
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

const splitTriggerTokens = (value: unknown) => {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const tokens: string[] = [];
  for (const item of source) {
    if (typeof item !== "string") continue;
    for (const part of item.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        tokens.push(trimmed);
      }
    }
  }
  return tokens;
};

const buildLoraLibraryMap = (library: Lora[]) => {
  const map = new Map<string, Lora>();
  for (const entry of library) {
    const fileName = typeof entry.fileName === "string" ? entry.fileName : "";
    if (!fileName) continue;
    const key = normalizeLoraFileKey(fileName);
    if (!key || map.has(key)) continue;
    map.set(key, entry);
  }
  return map;
};

const dedupeTokensByKey = (tokens: string[]) => {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const token of tokens) {
    const key = normalizeTokenKey(token);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(token);
  }
  return next;
};

const filterLoraNames = (names: string[], query: string) => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return names.slice(0, LORA_RESULT_LIMIT);
  const matches = names.filter((name) => name.toLowerCase().includes(normalized));
  const prefix: string[] = [];
  const rest: string[] = [];
  for (const name of matches) {
    if (name.toLowerCase().startsWith(normalized)) {
      prefix.push(name);
    } else {
      rest.push(name);
    }
  }
  return [...prefix, ...rest].slice(0, LORA_RESULT_LIMIT);
};

const resolveRunsPollInterval = (elapsedMs: number) => {
  if (elapsedMs < 15_000) return RUNS_POLL_INTERVAL_MS.fast;
  if (elapsedMs < 60_000) return RUNS_POLL_INTERVAL_MS.medium;
  return RUNS_POLL_INTERVAL_MS.slow;
};

const parseNumberValue = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
};

const parseMaybeJson = (value: unknown) => {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value === "object") return value as Record<string, unknown>;
  return null;
};

const resolveStringField = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return "";
};

const resolveNumberField = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};


const normalizeDefaults = (value: unknown): ComfyDefaults | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, any>;
  const toNumberValue = (input: unknown, fallback = 0) => {
    const parsed = typeof input === "number" ? input : Number(input);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const toStringValue = (input: unknown) => (typeof input === "string" ? input : "");

  const loader = record.efficientLoaderDefaults ?? {};
  const controlnet = record.controlnetDefaults ?? {};
  const ksampler = record.ksamplerDefaults ?? {};
  const lorasRaw = Array.isArray(record.loraDefaults) ? record.loraDefaults : [];

  return {
    efficientLoaderDefaults: {
      ckptName: toStringValue(loader.ckptName),
      positive: toStringValue(loader.positive),
      negative: toStringValue(loader.negative),
      width: Math.trunc(toNumberValue(loader.width, 0)),
      height: Math.trunc(toNumberValue(loader.height, 0))
    },
    loraDefaults: lorasRaw.map((item: any) => ({
      name: toStringValue(item?.name),
      weight: toNumberValue(item?.weight, 1)
    })),
    controlnetDefaults: {
      modelName: toStringValue(controlnet.modelName),
      preprocessor: toStringValue(controlnet.preprocessor),
      strength: toNumberValue(controlnet.strength, 0),
      enabled: Boolean(controlnet.enabled),
      imageName: typeof controlnet.imageName === "string" ? controlnet.imageName : null
    },
    ksamplerDefaults: {
      steps: Math.trunc(toNumberValue(ksampler.steps, 0)),
      cfg: toNumberValue(ksampler.cfg, 0),
      sampler_name: toStringValue(ksampler.sampler_name || ksampler.sampler),
      scheduler: toStringValue(ksampler.scheduler),
      denoise: toNumberValue(ksampler.denoise, 0),
      seed: toNumberValue(ksampler.seed, -1)
    }
  };
};

const normalizeImage2iDefaults = (value: unknown): ComfyImage2iDefaults | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, any>;
  const parsed = Number(record.ksamplerDenoiseDefault);
  if (!Number.isFinite(parsed)) return null;
  return { ksamplerDenoiseDefault: parsed };
};

const formatTimestamp = (value?: string | null) => {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
};

const buildViewUrl = (output: RunOutput) => {
  const params = new URLSearchParams({ filename: output.filename });
  if (output.subfolder) params.set("subfolder", output.subfolder);
  if (output.type) params.set("type", output.type);
  return `${API_BASE_URL}/api/comfy/view?${params.toString()}`;
};

const resolveGalleryItemViewUrl = (item: GalleryItemSummary) => {
  if (!item.viewUrl) return "";
  return item.viewUrl.startsWith("http") ? item.viewUrl : `${API_BASE_URL}${item.viewUrl}`;
};

export default function PlayComfyRunnerPage() {
  const [searchParams] = useSearchParams();
  const rehydrateRunId = searchParams.get("rehydrateRunId");
  const rehydrateGalleryItemId = searchParams.get("rehydrateGalleryItemId");
  const [options, setOptions] = useState<ComfyOptionsData>(emptyOptions);
  const [isFetching, setIsFetching] = useState(false);
  const [debug, setDebug] = useState<OptionsDebugState>({
    attempt: 0,
    phase: "idle",
    lastUpdatedAt: null,
    lastError: null,
    lastRequestUrl: null,
    lastHttpStatus: null,
    lastRawText: null
  });
  const [defaults, setDefaults] = useState<ComfyDefaults | null>(null);
  const [image2iDefaults, setImage2iDefaults] = useState<ComfyImage2iDefaults | null>(null);
  const didInitDefaultsRef = useRef(false);
  const [ckptName, setCkptName] = useState("");
  const [positive, setPositive] = useState("");
  const [negative, setNegative] = useState("");
  const [tagDictionary, setTagDictionary] = useState<TagDictionary | null>(null);
  const [loraLibrary, setLoraLibrary] = useState<Lora[]>([]);
  const [width, setWidth] = useState("1216");
  const [height, setHeight] = useState("1728");
  const [controlnetEnabled, setControlnetEnabled] = useState(false);
  const [controlnetModel, setControlnetModel] = useState("");
  const [controlnetStrength, setControlnetStrength] = useState("1");
  const [preprocessorEnabled, setPreprocessorEnabled] = useState(false);
  const [preprocessor, setPreprocessor] = useState("");
  const [controlnetImageFile, setControlnetImageFile] = useState<File | null>(null);
  const [initImageFile, setInitImageFile] = useState<File | null>(null);
  const [initImagePreviewUrl, setInitImagePreviewUrl] = useState<string | null>(null);
  const initImageInputRef = useRef<HTMLInputElement | null>(null);
  const image2iDenoiseInitRef = useRef({ initialized: false, usedFallback: false });
  const [ksamplerOpen, setKsamplerOpen] = useState(false);
  const [ksamplerSteps, setKsamplerSteps] = useState("");
  const [ksamplerCfg, setKsamplerCfg] = useState("");
  const [ksamplerSampler, setKsamplerSampler] = useState("");
  const [ksamplerScheduler, setKsamplerScheduler] = useState("");
  const [ksamplerSeed, setKsamplerSeed] = useState("");
  const [ksamplerDenoise, setKsamplerDenoise] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitDebug, setSubmitDebug] = useState<SubmitDebugState>({
    phase: "idle",
    lastError: null,
    lastHttpStatus: null,
    lastRawText: null,
    lastRunId: null,
    lastPromptId: null
  });
  const [runs, setRuns] = useState<ComfyRun[]>([]);
    const [runsDebug, setRunsDebug] = useState<RunsDebugState>({
    attempt: 0,
    phase: "idle",
    lastUpdatedAt: null,
    lastError: null,
    lastHttpStatus: null,
    lastRawText: null
  });
    const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
    const nextLoraIdRef = useRef(1);
    const buildLoraRow = () => ({ id: nextLoraIdRef.current++, name: "", weight: "1" });
    const [loraRows, setLoraRows] = useState<LoraRow[]>(() => [buildLoraRow()]);
    const [activeLoraRowId, setActiveLoraRowId] = useState<number | null>(null);
  const buildLoraRowsFromRequest = (lorasRaw: unknown) => {
    nextLoraIdRef.current = 1;
    const rows: LoraRow[] = [];
    const candidates = Array.isArray(lorasRaw) ? lorasRaw : [];
    for (const entry of candidates) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const enabled = record.enabled === undefined ? true : Boolean(record.enabled);
      if (!enabled) continue;
      const name = resolveStringField(record, ["name", "lora_name", "loraName"]);
      if (!name) continue;
      const weightValue = resolveNumberField(record, ["weight", "lora_wt", "loraWeight"]);
      rows.push({
        id: nextLoraIdRef.current++,
        name,
        weight: weightValue !== null ? String(weightValue) : "1"
      });
    }
    if (rows.length === 0) rows.push(buildLoraRow());
    return rows;
  };
  const buildLoraRowsFromNames = (names?: string[] | null) => {
    nextLoraIdRef.current = 1;
    const rows = (names ?? [])
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .map((name) => ({
        id: nextLoraIdRef.current++,
        name,
        weight: "1"
      }));
    return rows.length > 0 ? rows : [buildLoraRow()];
  };
  const [rehydrateState, setRehydrateState] = useState<{
    phase: "idle" | "fetching" | "success" | "error";
    lastError: string | null;
    runId: string | null;
  }>({ phase: "idle", lastError: null, runId: null });
  const [rehydrateGalleryState, setRehydrateGalleryState] = useState<{
    phase: "idle" | "fetching" | "success" | "error";
    lastError: string | null;
    itemId: string | null;
  }>({ phase: "idle", lastError: null, itemId: null });
  const rehydrateInFlightRef = useRef<AbortController | null>(null);
  const rehydrateRequestIdRef = useRef(0);
  const rehydrateAppliedRef = useRef<string | null>(null);
  const rehydrateGalleryInFlightRef = useRef<AbortController | null>(null);
  const rehydrateGalleryRequestIdRef = useRef(0);
  const rehydrateGalleryAppliedRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const requestIdRef = useRef(0);
  const submitInFlightRef = useRef(false);
  const submitRequestIdRef = useRef(0);
  const runsInFlightRef = useRef(false);
  const runsRequestIdRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const refreshRequestIdRef = useRef(0);
  const deleteInFlightRef = useRef<Set<string>>(new Set());
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runsPollStartRef = useRef<number>(0);
  const activeRef = useRef(true);
  const loraLibraryInFlightRef = useRef(false);
  const loraLibraryRequestIdRef = useRef(0);
  const loraLibraryAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
      if (rehydrateInFlightRef.current) {
        rehydrateInFlightRef.current.abort();
      }
      if (rehydrateGalleryInFlightRef.current) {
        rehydrateGalleryInFlightRef.current.abort();
      }
      if (loraLibraryAbortRef.current) {
        loraLibraryAbortRef.current.abort();
      }
    };
  }, []);

  const fetchOptions = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    const url = `${API_BASE_URL}/api/comfy/runner/text2i/options`;
    setIsFetching(true);
    setDebug((prev) => ({
      ...prev,
      attempt: prev.attempt + 1,
      phase: "fetching",
      lastError: null,
      lastRequestUrl: url,
      lastHttpStatus: null,
      lastRawText: null
    }));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPTIONS_TIMEOUT_MS);
    let rawText = "";

    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      rawText = await response.text();

      if (!activeRef.current || requestId !== requestIdRef.current) {
        return;
      }

      const trimmed = truncateText(rawText);
        setDebug((prev) => ({
          ...prev,
          lastHttpStatus: response.status,
          lastRawText: trimmed
        }));

      if (!response.ok) {
        setDebug((prev) => ({
          ...prev,
          phase: "error",
          lastError: `HTTP ${response.status}`
        }));
        return;
      }

      let json: any = null;
      if (rawText.trim()) {
        try {
          json = JSON.parse(rawText);
        } catch (err) {
          setDebug((prev) => ({
            ...prev,
            phase: "error",
            lastError: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`
          }));
          return;
        }
      }

      if (!json || json.ok !== true) {
        setDebug((prev) => ({
          ...prev,
          phase: "error",
          lastError: json?.error?.message || "Options request failed"
        }));
        return;
      }

      const data = json.data ?? {};
      const nextOptions: ComfyOptionsData = {
        ckptNames: normalizeStringArray(data.ckptNames),
        loraNames: normalizeStringArray(data.loraNames),
        controlnetModelNames: normalizeStringArray(data.controlnetModelNames),
        preprocessorNames: normalizeStringArray(data.preprocessorNames),
        partialErrors: Array.isArray(data.partialErrors) ? data.partialErrors : []
      };

      setOptions(nextOptions);
      const nextDefaults = normalizeDefaults(data.defaults);
      setDefaults(nextDefaults);
      const nextImage2iDefaults = normalizeImage2iDefaults(data.image2iDefaults);
      setImage2iDefaults(nextImage2iDefaults);
      if (nextDefaults && !didInitDefaultsRef.current) {
        didInitDefaultsRef.current = true;
        setCkptName(nextDefaults.efficientLoaderDefaults.ckptName || "");
        setPositive(nextDefaults.efficientLoaderDefaults.positive || "");
        setNegative(nextDefaults.efficientLoaderDefaults.negative || "");
        setWidth(String(nextDefaults.efficientLoaderDefaults.width || ""));
        setHeight(String(nextDefaults.efficientLoaderDefaults.height || ""));

        nextLoraIdRef.current = 1;
        const loraRowsDefaults =
          nextDefaults.loraDefaults.length > 0
            ? nextDefaults.loraDefaults.map((item) => ({
                id: nextLoraIdRef.current++,
                name: item.name === "None" ? "" : item.name,
                weight: String(item.weight ?? 1)
              }))
            : [{ id: nextLoraIdRef.current++, name: "", weight: "1" }];
        setLoraRows(loraRowsDefaults);

        setControlnetEnabled(false);
        setControlnetModel(nextDefaults.controlnetDefaults.modelName || "");
        setControlnetStrength(String(nextDefaults.controlnetDefaults.strength ?? 0));
        setPreprocessor(nextDefaults.controlnetDefaults.preprocessor || "");
        setPreprocessorEnabled(false);

        setKsamplerSteps(String(nextDefaults.ksamplerDefaults.steps || ""));
        setKsamplerCfg(String(nextDefaults.ksamplerDefaults.cfg || ""));
        setKsamplerSampler(nextDefaults.ksamplerDefaults.sampler_name || "");
        setKsamplerScheduler(nextDefaults.ksamplerDefaults.scheduler || "");
        setKsamplerDenoise(String(nextDefaults.ksamplerDefaults.denoise || ""));
        setKsamplerSeed(String(nextDefaults.ksamplerDefaults.seed ?? -1));
      }
      setDebug((prev) => ({
        ...prev,
        phase: "success",
        lastUpdatedAt: new Date().toISOString()
      }));
    } catch (err) {
      if (!activeRef.current || requestId !== requestIdRef.current) {
        return;
      }
      const isTimeout = err instanceof Error && err.name === "AbortError";
      setDebug((prev) => ({
        ...prev,
        phase: "error",
        lastError: isTimeout ? "timeout" : err instanceof Error ? err.message : String(err)
      }));
    } finally {
      clearTimeout(timeoutId);
      if (activeRef.current && requestId === requestIdRef.current) {
        setIsFetching(false);
      }
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchOptions();
  }, [fetchOptions]);

  const fetchLoraLibrary = useCallback(async (): Promise<Lora[] | null> => {
    if (loraLibraryInFlightRef.current) return;
    loraLibraryInFlightRef.current = true;
    const requestId = loraLibraryRequestIdRef.current + 1;
    loraLibraryRequestIdRef.current = requestId;

    const controller = new AbortController();
    loraLibraryAbortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), LORA_LIBRARY_TIMEOUT_MS);
    let rawText = "";

    try {
      const response = await fetch(`${API_BASE_URL}/api/loras`, {
        signal: controller.signal,
        cache: "no-store"
      });
      rawText = await response.text();

      if (!activeRef.current || requestId !== loraLibraryRequestIdRef.current) {
        return;
      }

      if (!response.ok) {
        return null;
      }

      let json: any = null;
      if (rawText.trim()) {
        try {
          json = JSON.parse(rawText);
        } catch {
          return null;
        }
      }

      if (!json || json.ok !== true) {
        return null;
      }

      const nextLoras = Array.isArray(json.data?.loras) ? json.data.loras : [];
      setLoraLibrary(nextLoras);
      return nextLoras;
    } catch {
      if (!activeRef.current || requestId !== loraLibraryRequestIdRef.current) {
        return;
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
      if (loraLibraryAbortRef.current === controller) {
        loraLibraryAbortRef.current = null;
      }
      loraLibraryInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchLoraLibrary();
  }, [fetchLoraLibrary]);

  useEffect(() => {
    if (!rehydrateRunId) return;
    if (rehydrateAppliedRef.current === rehydrateRunId) return;

    if (rehydrateInFlightRef.current) {
      rehydrateInFlightRef.current.abort();
    }

    const controller = new AbortController();
    rehydrateInFlightRef.current = controller;
    const requestId = rehydrateRequestIdRef.current + 1;
    rehydrateRequestIdRef.current = requestId;
    setRehydrateState({ phase: "fetching", lastError: null, runId: rehydrateRunId });

    const timeoutId = setTimeout(() => controller.abort(), REHYDRATE_TIMEOUT_MS);

    const run = async () => {
      let rawText = "";
      try {
        const response = await fetch(`${API_BASE_URL}/api/comfy/runs/${encodeURIComponent(rehydrateRunId)}`, {
          cache: "no-store",
          signal: controller.signal
        });
        rawText = await response.text();

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const json = rawText ? (JSON.parse(rawText) as any) : null;
        if (!json || json.ok !== true || !json.data?.run) {
          throw new Error(json?.error?.message || "Invalid response");
        }

        if (!activeRef.current || requestId !== rehydrateRequestIdRef.current) return;
        const runData = json.data.run as ComfyRun;
        const request = (parseMaybeJson(runData.request_json) ?? {}) as Record<string, unknown>;

        const ckpt = resolveStringField(request, ["ckptName", "ckpt_name", "checkpoint", "checkpointName"]);
        const positiveValue = typeof request.positive === "string" ? request.positive : "";
        const negativeValue = typeof request.negative === "string" ? request.negative : "";
        const widthValue = resolveNumberField(request, ["width", "empty_latent_width", "emptyLatentWidth"]);
        const heightValue = resolveNumberField(request, ["height", "empty_latent_height", "emptyLatentHeight"]);

        if (ckpt) setCkptName(ckpt);
        setPositive(positiveValue);
        setNegative(negativeValue);
        if (widthValue !== null) setWidth(String(Math.trunc(widthValue)));
        if (heightValue !== null) setHeight(String(Math.trunc(heightValue)));
        setLoraRows(buildLoraRowsFromRequest(request.loras));
        setActiveLoraRowId(null);
        didInitDefaultsRef.current = true;

        rehydrateAppliedRef.current = rehydrateRunId;
        setRehydrateState({ phase: "success", lastError: null, runId: rehydrateRunId });
      } catch (err) {
        if (!activeRef.current || requestId !== rehydrateRequestIdRef.current) return;
        const isTimeout = err instanceof Error && err.name === "AbortError";
        const message = isTimeout ? "timeout" : err instanceof Error ? err.message : String(err);
        setRehydrateState({ phase: "error", lastError: message, runId: rehydrateRunId });
      } finally {
        clearTimeout(timeoutId);
        if (rehydrateInFlightRef.current === controller) {
          rehydrateInFlightRef.current = null;
        }
      }
    };

    run();
  }, [rehydrateRunId]);

  useEffect(() => {
    if (!rehydrateGalleryItemId) return;
    if (rehydrateGalleryAppliedRef.current === rehydrateGalleryItemId) return;

    if (rehydrateGalleryInFlightRef.current) {
      rehydrateGalleryInFlightRef.current.abort();
    }

    const controller = new AbortController();
    rehydrateGalleryInFlightRef.current = controller;
    const requestId = rehydrateGalleryRequestIdRef.current + 1;
    rehydrateGalleryRequestIdRef.current = requestId;
    setRehydrateGalleryState({ phase: "fetching", lastError: null, itemId: rehydrateGalleryItemId });

    const timeoutId = setTimeout(() => controller.abort(), REHYDRATE_TIMEOUT_MS);

    const run = async () => {
      let rawText = "";
      try {
        const response = await fetch(
          `${API_BASE_URL}/api/gallery/items/${encodeURIComponent(rehydrateGalleryItemId)}`,
          {
            cache: "no-store",
            signal: controller.signal
          }
        );
        rawText = await response.text();

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const json = rawText ? (JSON.parse(rawText) as any) : null;
        if (!json || json.ok !== true || !json.data?.item) {
          throw new Error(json?.error?.message || "Invalid response");
        }

        if (!activeRef.current || requestId !== rehydrateGalleryRequestIdRef.current) return;
        const item = json.data.item as GalleryItemSummary;
        const viewUrl = resolveGalleryItemViewUrl(item);

        if (!rehydrateRunId) {
          if (item.ckpt_name) setCkptName(item.ckpt_name);
          setPositive(item.positive ?? "");
          setNegative(item.negative ?? "");
          if (typeof item.width === "number") setWidth(String(Math.trunc(item.width)));
          if (typeof item.height === "number") setHeight(String(Math.trunc(item.height)));
          setLoraRows(buildLoraRowsFromNames(item.lora_names));
          setActiveLoraRowId(null);
          didInitDefaultsRef.current = true;
        }

        if (viewUrl) {
          const imageResponse = await fetch(viewUrl, { cache: "no-store", signal: controller.signal });
          if (!imageResponse.ok) {
            throw new Error(`image HTTP ${imageResponse.status}`);
          }
          const blob = await imageResponse.blob();
          const fallbackName = `gallery_${item.id}.png`;
          const fileName = item.filename && item.filename.trim().length > 0 ? item.filename : fallbackName;
          const fileType = blob.type || "image/png";
          const file = new File([blob], fileName, { type: fileType });
          setInitImageFile(file);
        }

        rehydrateGalleryAppliedRef.current = rehydrateGalleryItemId;
        setRehydrateGalleryState({ phase: "success", lastError: null, itemId: rehydrateGalleryItemId });
      } catch (err) {
        if (!activeRef.current || requestId !== rehydrateGalleryRequestIdRef.current) return;
        const isTimeout = err instanceof Error && err.name === "AbortError";
        const message = isTimeout ? "timeout" : err instanceof Error ? err.message : String(err);
        setRehydrateGalleryState({ phase: "error", lastError: message, itemId: rehydrateGalleryItemId });
      } finally {
        clearTimeout(timeoutId);
        if (rehydrateGalleryInFlightRef.current === controller) {
          rehydrateGalleryInFlightRef.current = null;
        }
      }
    };

    run();
  }, [rehydrateGalleryItemId, rehydrateRunId]);

  useEffect(() => {
    if (!ckptName && options.ckptNames.length > 0) {
      setCkptName(options.ckptNames[0]);
    }
  }, [ckptName, options.ckptNames]);

  useEffect(() => {
    if (!controlnetModel && options.controlnetModelNames.length > 0) {
      setControlnetModel(options.controlnetModelNames[0]);
    }
  }, [controlnetModel, options.controlnetModelNames]);

  useEffect(() => {
    if (!preprocessor && options.preprocessorNames.length > 0) {
      setPreprocessor(options.preprocessorNames[0]);
    }
  }, [preprocessor, options.preprocessorNames]);

  useEffect(() => {
    if (!initImageFile) {
      setInitImagePreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(initImageFile);
    setInitImagePreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [initImageFile]);

  useEffect(() => {
    if (!initImageFile) {
      image2iDenoiseInitRef.current = { initialized: false, usedFallback: false };
      return;
    }
    if (image2iDenoiseInitRef.current.initialized) {
      if (image2iDenoiseInitRef.current.usedFallback && image2iDefaults?.ksamplerDenoiseDefault !== undefined) {
        setKsamplerDenoise(String(image2iDefaults.ksamplerDenoiseDefault));
        image2iDenoiseInitRef.current = { initialized: true, usedFallback: false };
      }
      return;
    }
    const fallbackValue = image2iDefaults?.ksamplerDenoiseDefault ?? 0.7;
    setKsamplerDenoise(String(fallbackValue));
    image2iDenoiseInitRef.current = {
      initialized: true,
      usedFallback: image2iDefaults?.ksamplerDenoiseDefault === undefined
    };
  }, [initImageFile, image2iDefaults]);

  const isOptionDisabled = (items: string[]) => isFetching && items.length === 0;
  const ckptDisabled = isOptionDisabled(options.ckptNames);
  const loraDisabled = isOptionDisabled(options.loraNames);
  const isImage2i = Boolean(initImageFile);
  const loraLibraryByFileName = useMemo(() => buildLoraLibraryMap(loraLibrary), [loraLibrary]);
  const resolveLoraTriggerTokens = useCallback(
    (loraName: string, mapOverride?: Map<string, Lora>) => {
      const lookup = mapOverride ?? loraLibraryByFileName;
      const key = normalizeLoraFileKey(loraName);
      if (!key) return [];
      const entry = lookup.get(key);
      if (!entry) return [];
      const raw = (entry as any).trigger_words ?? (entry as any).triggerWords;
      return dedupeTokensByKey(splitTriggerTokens(raw));
    },
    [loraLibraryByFileName]
  );
  const positiveTokenKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const token of splitPromptTokens(positive)) {
      const normalized = normalizeTokenKey(token);
      if (normalized) keys.add(normalized);
    }
    return keys;
  }, [positive]);

  const insertPositiveTokens = useCallback(
    (incoming: string[]) => {
      if (incoming.length === 0) return;
      const existing = splitPromptTokens(positive);
      const seen = new Set(existing.map((token) => normalizeTokenKey(token)).filter((key) => key.length > 0));
      const next = [...existing];
      for (const token of incoming) {
        const trimmed = token.trim().replace(/\s+/g, " ");
        const key = normalizeTokenKey(trimmed);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        next.push(trimmed);
      }
      if (next.length !== existing.length) {
        setPositive(next.join(", "));
      }
    },
    [positive, setPositive]
  );

  const handleInsertLoraTriggers = useCallback(
    async (loraName: string) => {
      if (!loraName.trim()) return;
      let lookupMap = loraLibraryByFileName;
      if (lookupMap.size === 0) {
        const nextLibrary = await fetchLoraLibrary();
        if (nextLibrary && nextLibrary.length > 0) {
          lookupMap = buildLoraLibraryMap(nextLibrary);
        }
      }
      const triggers = resolveLoraTriggerTokens(loraName, lookupMap);
      insertPositiveTokens(triggers);
    },
    [fetchLoraLibrary, insertPositiveTokens, loraLibraryByFileName, resolveLoraTriggerTokens]
  );

  const handleSwapSize = () => {
    setWidth(height);
    setHeight(width);
  };

  const handleClearInitImage = () => {
    setInitImageFile(null);
    if (initImageInputRef.current) {
      initImageInputRef.current.value = "";
    }
  };

  const handleAddLora = () => {
    setLoraRows((rows) => [...rows, buildLoraRow()]);
  };

  const handleRemoveLora = (id: number) => {
    setLoraRows((rows) => {
      if (rows.length <= 1) {
        return rows.map((row) => (row.id === id ? { ...row, name: "", weight: "1" } : row));
      }
      return rows.filter((row) => row.id !== id);
    });
  };

  const toggleRun = (runId: string) => {
    setExpandedRuns((prev) => ({ ...prev, [runId]: !prev[runId] }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitInFlightRef.current) return;

    const widthValue = parseNumberValue(width);
    const heightValue = parseNumberValue(height);
    if (!ckptName.trim()) {
      setSubmitDebug((prev) => ({ ...prev, phase: "error", lastError: "ckptName is required" }));
      return;
    }
    if (widthValue === undefined || heightValue === undefined || !Number.isInteger(widthValue) || !Number.isInteger(heightValue)) {
      setSubmitDebug((prev) => ({ ...prev, phase: "error", lastError: "width/height must be integers" }));
      return;
    }
    if (widthValue < 64 || heightValue < 64) {
      setSubmitDebug((prev) => ({ ...prev, phase: "error", lastError: "width/height must be >= 64" }));
      return;
    }

    const controlnetActive = controlnetEnabled;
    const preprocessorActive = controlnetActive && preprocessorEnabled;
    if (controlnetActive && !controlnetModel.trim()) {
      setSubmitDebug((prev) => ({ ...prev, phase: "error", lastError: "controlnetModel is required" }));
      return;
    }
    if (preprocessorActive && !preprocessor.trim()) {
      setSubmitDebug((prev) => ({ ...prev, phase: "error", lastError: "preprocessor is required" }));
      return;
    }

    submitInFlightRef.current = true;
    const requestId = submitRequestIdRef.current + 1;
    submitRequestIdRef.current = requestId;
    setIsSubmitting(true);
    setSubmitDebug({
      phase: "submitting",
      lastError: null,
      lastHttpStatus: null,
      lastRawText: null,
      lastRunId: null,
      lastPromptId: null
    });

    const lorasPayload = loraRows
      .map((row) => ({
        name: row.name.trim(),
        weight: parseNumberValue(row.weight) ?? 1,
        enabled: true
      }))
      .filter((row) => row.name.length > 0);

    const ksampler: Record<string, unknown> = {};
    const stepsValue = parseNumberValue(ksamplerSteps);
    const cfgValue = parseNumberValue(ksamplerCfg);
    const seedValue = parseNumberValue(ksamplerSeed);
    const denoiseValue = parseNumberValue(ksamplerDenoise);
    if (stepsValue !== undefined) ksampler.steps = Math.trunc(stepsValue);
    if (cfgValue !== undefined) ksampler.cfg = cfgValue;
    if (ksamplerSampler.trim()) ksampler.sampler = ksamplerSampler.trim();
    if (ksamplerScheduler.trim()) ksampler.scheduler = ksamplerScheduler.trim();
    if (seedValue !== undefined) ksampler.seed = Math.trunc(seedValue);
    if (denoiseValue !== undefined && isImage2i) ksampler.denoise = denoiseValue;
    const ksamplerPayload = Object.keys(ksampler).length > 0 ? ksampler : undefined;

    const controlnetStrengthValue = parseNumberValue(controlnetStrength);

    const form = new FormData();
    form.append("workflowId", isImage2i ? "base_image2i" : "base_text2i");
    form.append("positive", positive);
    form.append("negative", negative);
    form.append("ckptName", ckptName);
    form.append("width", String(widthValue));
    form.append("height", String(heightValue));
    form.append("loras", JSON.stringify(lorasPayload));
    form.append("controlnetEnabled", String(controlnetActive));
    form.append("preprocessorEnabled", String(preprocessorActive));
    if (controlnetActive && controlnetModel.trim()) {
      form.append("controlnetModel", controlnetModel.trim());
    }
    if (preprocessorActive && preprocessor.trim()) {
      form.append("preprocessor", preprocessor.trim());
    }
    if (controlnetActive && controlnetStrengthValue !== undefined) {
      form.append("controlnetStrength", String(controlnetStrengthValue));
    }
    if (ksamplerPayload) {
      form.append("ksampler", JSON.stringify(ksamplerPayload));
    }
    if (controlnetActive && controlnetImageFile) {
      form.append("controlnetImage", controlnetImageFile);
    }
    if (isImage2i && initImageFile) {
      form.append("initImage", initImageFile);
    }

    const url = `${API_BASE_URL}/api/comfy/runs`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RUN_SUBMIT_TIMEOUT_MS);
    let rawText = "";

    try {
      const response = await fetch(url, { method: "POST", body: form, signal: controller.signal, cache: "no-store" });
      rawText = await response.text();

      if (!activeRef.current || requestId !== submitRequestIdRef.current) {
        return;
      }

      const trimmed = truncateText(rawText);
      setSubmitDebug((prev) => ({
        ...prev,
        lastHttpStatus: response.status,
        lastRawText: trimmed
      }));

      if (!response.ok) {
        setSubmitDebug((prev) => ({
          ...prev,
          phase: "error",
          lastError: `HTTP ${response.status}`
        }));
        return;
      }

      let json: any = null;
      if (rawText.trim()) {
        try {
          json = JSON.parse(rawText);
        } catch (err) {
          setSubmitDebug((prev) => ({
            ...prev,
            phase: "error",
            lastError: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`
          }));
          return;
        }
      }

      if (!json || json.ok !== true) {
        setSubmitDebug((prev) => ({
          ...prev,
          phase: "error",
          lastError: json?.error?.message || "Run request failed"
        }));
        return;
      }

      const run = json?.data?.run ?? null;
      const runId = run && typeof run.id === "string" ? run.id : null;
      const promptId = run && typeof run.prompt_id === "string" ? run.prompt_id : null;
      setSubmitDebug((prev) => ({
        ...prev,
        phase: "success",
        lastError: null,
        lastRunId: runId,
        lastPromptId: promptId
      }));
    } catch (err) {
      if (!activeRef.current || requestId !== submitRequestIdRef.current) {
        return;
      }
      const isTimeout = err instanceof Error && err.name === "AbortError";
      setSubmitDebug((prev) => ({
        ...prev,
        phase: "error",
        lastError: isTimeout ? "timeout" : err instanceof Error ? err.message : String(err)
      }));
    } finally {
      clearTimeout(timeoutId);
      if (activeRef.current && requestId === submitRequestIdRef.current) {
        setIsSubmitting(false);
      }
      submitInFlightRef.current = false;
    }
  };

  const refreshRun = useCallback(async (runId: string) => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;

    const url = `${API_BASE_URL}/api/comfy/runs/${runId}/refresh`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RUNS_REFRESH_TIMEOUT_MS);
    let rawText = "";

    try {
      const response = await fetch(url, { method: "POST", signal: controller.signal, cache: "no-store" });
      rawText = await response.text();

      if (!activeRef.current || requestId !== refreshRequestIdRef.current) {
        return;
      }

      const trimmed = truncateText(rawText);
      setRunsDebug((prev) => ({
        ...prev,
        lastHttpStatus: response.status,
        lastRawText: trimmed
      }));

      if (!response.ok) {
        setRunsDebug((prev) => ({
          ...prev,
          phase: "error",
          lastError: `refresh HTTP ${response.status}`
        }));
        return;
      }

      let json: any = null;
      if (rawText.trim()) {
        try {
          json = JSON.parse(rawText);
        } catch (err) {
          setRunsDebug((prev) => ({
            ...prev,
            phase: "error",
            lastError: `refresh invalid JSON: ${err instanceof Error ? err.message : String(err)}`
          }));
          return;
        }
      }

      if (!json || json.ok !== true) {
        setRunsDebug((prev) => ({
          ...prev,
          phase: "error",
          lastError: json?.error?.message || "refresh failed"
        }));
        return;
      }

      const refreshed = json?.data?.run;
      if (refreshed && typeof refreshed.id === "string") {
        setRuns((prev) => prev.map((run) => (run.id === refreshed.id ? refreshed : run)));
      }
      setRunsDebug((prev) => ({
        ...prev,
        phase: "success",
        lastUpdatedAt: new Date().toISOString(),
        lastError: null
      }));
    } catch (err) {
      if (!activeRef.current || requestId !== refreshRequestIdRef.current) {
        return;
      }
      const isTimeout = err instanceof Error && err.name === "AbortError";
      setRunsDebug((prev) => ({
        ...prev,
        phase: "error",
        lastError: isTimeout ? "refresh timeout" : err instanceof Error ? err.message : String(err)
      }));
    } finally {
      clearTimeout(timeoutId);
      refreshInFlightRef.current = false;
    }
  }, []);

  const fetchRuns = useCallback(async () => {
    if (runsInFlightRef.current) return;
    runsInFlightRef.current = true;
    const requestId = runsRequestIdRef.current + 1;
    runsRequestIdRef.current = requestId;

    const url = `${API_BASE_URL}/api/comfy/runs`;
    setRunsDebug((prev) => ({
      ...prev,
      attempt: prev.attempt + 1,
      phase: "fetching",
      lastError: null,
      lastHttpStatus: null,
      lastRawText: null
    }));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RUNS_FETCH_TIMEOUT_MS);
    let rawText = "";

    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      rawText = await response.text();

      if (!activeRef.current || requestId !== runsRequestIdRef.current) {
        return;
      }

      const trimmed = truncateText(rawText);
      setRunsDebug((prev) => ({
        ...prev,
        lastHttpStatus: response.status,
        lastRawText: trimmed
      }));

      if (!response.ok) {
        setRunsDebug((prev) => ({
          ...prev,
          phase: "error",
          lastError: `HTTP ${response.status}`
        }));
        return;
      }

      let json: any = null;
      if (rawText.trim()) {
        try {
          json = JSON.parse(rawText);
        } catch (err) {
          setRunsDebug((prev) => ({
            ...prev,
            phase: "error",
            lastError: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`
          }));
          return;
        }
      }

      if (!json || json.ok !== true) {
        setRunsDebug((prev) => ({
          ...prev,
          phase: "error",
          lastError: json?.error?.message || "Runs request failed"
        }));
        return;
      }

      const list = Array.isArray(json?.data?.runs) ? (json.data.runs as ComfyRun[]) : [];
      setRuns(list);
      setRunsDebug((prev) => ({
        ...prev,
        phase: "success",
        lastUpdatedAt: new Date().toISOString(),
        lastError: null
      }));

      const target = list.find(
        (run) =>
          run.status === "queued" ||
          run.status === "running" ||
          (run.status === "failed" && run.error_message === "history_empty")
      );
      if (target) {
        await refreshRun(target.id);
      }
    } catch (err) {
      if (!activeRef.current || requestId !== runsRequestIdRef.current) {
        return;
      }
      const isTimeout = err instanceof Error && err.name === "AbortError";
      setRunsDebug((prev) => ({
        ...prev,
        phase: "error",
        lastError: isTimeout ? "timeout" : err instanceof Error ? err.message : String(err)
      }));
    } finally {
      clearTimeout(timeoutId);
      runsInFlightRef.current = false;
    }
  }, [refreshRun]);

  useEffect(() => {
    let cancelled = false;
      runsPollStartRef.current = Date.now();
      const tick = async () => {
        if (cancelled || !activeRef.current) return;
        await fetchRuns();
        if (cancelled || !activeRef.current) return;
        const elapsedMs = Date.now() - runsPollStartRef.current;
        pollTimerRef.current = setTimeout(tick, resolveRunsPollInterval(elapsedMs));
      };
    tick();
    return () => {
      cancelled = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, [fetchRuns]);

  const handleDeleteRun = async (runId: string) => {
    if (deleteInFlightRef.current.has(runId)) return;
    deleteInFlightRef.current.add(runId);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RUNS_DELETE_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE_URL}/api/comfy/runs/${runId}`, {
        method: "DELETE",
        signal: controller.signal,
        cache: "no-store"
      });
      if (!response.ok) {
        setRunsDebug((prev) => ({
          ...prev,
          phase: "error",
          lastError: `delete HTTP ${response.status}`,
          lastHttpStatus: response.status
        }));
        return;
      }
      setRuns((prev) => prev.filter((run) => run.id !== runId));
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "AbortError";
      setRunsDebug((prev) => ({
        ...prev,
        phase: "error",
        lastError: isTimeout ? "delete timeout" : err instanceof Error ? err.message : String(err)
      }));
    } finally {
      clearTimeout(timeoutId);
      deleteInFlightRef.current.delete(runId);
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Comfy Runner</p>
        <h1 className="text-3xl font-semibold">Text2Img Runner</h1>
        <p className="text-sm text-slate-300">
          Options は `/api/comfy/runner/text2i/options` を 1 本だけ叩いて取得します。
        </p>
        {rehydrateState.phase === "fetching" && (
          <p className="text-xs text-slate-400">Rehydrate: {rehydrateState.runId ?? "-"} を取得中...</p>
        )}
        {rehydrateState.phase === "success" && (
          <p className="text-xs text-emerald-300">Rehydrate: {rehydrateState.runId ?? "-"} を復元しました。</p>
        )}
        {rehydrateState.phase === "error" && (
          <p className="text-xs text-rose-300">
            Rehydrate 失敗: {rehydrateState.lastError ?? "-"}
          </p>
        )}
        {rehydrateGalleryState.phase === "fetching" && (
          <p className="text-xs text-slate-400">Rehydrate(Gallery): {rehydrateGalleryState.itemId ?? "-"} を取得中...</p>
        )}
        {rehydrateGalleryState.phase === "success" && (
          <p className="text-xs text-emerald-300">
            Rehydrate(Gallery): {rehydrateGalleryState.itemId ?? "-"} を復元しました。
          </p>
        )}
        {rehydrateGalleryState.phase === "error" && (
          <p className="text-xs text-rose-300">
            Rehydrate(Gallery) 失敗: {rehydrateGalleryState.lastError ?? "-"}
          </p>
        )}
      </section>

      <form onSubmit={handleSubmit} className="space-y-6">
        <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 shadow-lg shadow-black/40">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Run Settings</h2>
            <button
              type="button"
              onClick={fetchOptions}
              disabled={isFetching}
              className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isFetching ? "Loading..." : "Reload"}
            </button>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm text-slate-300">Checkpoint</label>
              <select
                className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
                disabled={ckptDisabled}
                value={ckptName}
                onChange={(event) => setCkptName(event.target.value)}
              >
                <option value="">選択してください</option>
                {options.ckptNames.length === 0 ? (
                  <option value="">候補がありません</option>
                ) : (
                  options.ckptNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))
                )}
              </select>
              {ckptDisabled && (
                <p className="text-xs text-slate-400">Options を取得中です。取得後に選択できます。</p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm text-slate-300">Size</label>
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <input
                  type="number"
                  min={64}
                  value={width}
                  onChange={(event) => setWidth(event.target.value)}
                  disabled={isImage2i}
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
                  placeholder="Width"
                />
                <input
                  type="number"
                  min={64}
                  value={height}
                  onChange={(event) => setHeight(event.target.value)}
                  disabled={isImage2i}
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
                  placeholder="Height"
                />
                <button
                  type="button"
                  onClick={handleSwapSize}
                  disabled={isImage2i}
                  className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
                >
                  Swap
                </button>
              </div>
              {isImage2i && (
                <p className="text-xs text-slate-400">i2i では参照画像サイズに従うため、Size は無視されます。</p>
              )}
            </div>
            {isImage2i && (
              <div className="space-y-2 md:col-span-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm text-slate-300">Denoise (i2i)</label>
                  <span className="text-xs text-slate-400">{ksamplerDenoise || "0.7"}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={ksamplerDenoise || "0.7"}
                  onChange={(event) => setKsamplerDenoise(event.target.value)}
                  className="w-full accent-emerald-400"
                />
              </div>
            )}
            <div className="space-y-2 md:col-span-2">
              <div className="flex items-center justify-between">
                <label className="text-sm text-slate-300">Init Image (i2i)</label>
                {initImageFile && (
                  <button
                    type="button"
                    onClick={handleClearInitImage}
                    className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
                  >
                    Clear
                  </button>
                )}
              </div>
              <input
                ref={initImageInputRef}
                type="file"
                accept="image/*"
                onChange={(event) => setInitImageFile(event.target.files?.[0] ?? null)}
                className="w-full text-sm text-slate-200 file:mr-3 file:rounded-md file:border file:border-slate-700 file:bg-slate-900 file:px-3 file:py-2 file:text-xs file:text-slate-200 file:transition hover:file:border-emerald-400/60 hover:file:text-white"
              />
              {initImagePreviewUrl ? (
                <div className="mt-2 inline-flex max-w-xs overflow-hidden rounded-md border border-slate-800 bg-slate-900/60 p-2">
                  <img src={initImagePreviewUrl} alt="init preview" className="h-24 w-auto rounded object-contain" />
                </div>
              ) : (
                <p className="text-xs text-slate-500">未選択の場合は t2i として実行されます。</p>
              )}
              {initImageFile && <p className="text-xs text-slate-400">Selected: {initImageFile.name}</p>}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 shadow-lg shadow-black/40">
          <h2 className="text-lg font-semibold">Prompts</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <PromptComposer
              label="Positive"
              target="positive"
              value={positive}
              onChange={setPositive}
              onClear={() => setPositive("")}
              placeholder="Add tags..."
            />
            <PromptComposer
              label="Negative"
              target="negative"
              value={negative}
              onChange={setNegative}
              onClear={() => setNegative("")}
              placeholder="Add negative tags..."
            />
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 shadow-lg shadow-black/40">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">LoRA</h2>
            <button
              type="button"
              onClick={handleAddLora}
              className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
            >
              Add
            </button>
          </div>
            <div className="mt-4 space-y-3">
              {loraRows.map((row) => {
                const hasLoraName = row.name.trim().length > 0;
                const rowTriggers = hasLoraName ? resolveLoraTriggerTokens(row.name) : [];
                return (
                  <div key={row.id} className="space-y-2">
                    <div className="grid gap-2 md:grid-cols-[1fr_120px_auto]">
                      <div className="relative">
                        <input
                          type="text"
                          placeholder="Search LoRA..."
                          className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none disabled:opacity-60"
                          disabled={loraDisabled}
                          value={row.name}
                          onFocus={() => setActiveLoraRowId(row.id)}
                          onBlur={() => {
                            setTimeout(() => {
                              setActiveLoraRowId((current) => (current === row.id ? null : current));
                            }, 120);
                          }}
                          onChange={(event) =>
                            setLoraRows((rows) =>
                              rows.map((item) => (item.id === row.id ? { ...item, name: event.target.value } : item))
                            )
                          }
                        />
                        {activeLoraRowId === row.id && !loraDisabled && (
                          <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-slate-800 bg-slate-950 text-sm text-slate-200 shadow-lg">
                            {filterLoraNames(options.loraNames, row.name).length === 0 ? (
                              <div className="px-3 py-2 text-xs text-slate-500">No matches</div>
                            ) : (
                              filterLoraNames(options.loraNames, row.name).map((name) => (
                                <button
                                  key={name}
                                  type="button"
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => {
                                    setLoraRows((rows) =>
                                      rows.map((item) => (item.id === row.id ? { ...item, name } : item))
                                    );
                                    setActiveLoraRowId(null);
                                  }}
                                  className="block w-full px-3 py-2 text-left text-xs text-slate-200 transition hover:bg-slate-800"
                                >
                                  {name}
                                </button>
                              ))
                            )}
                            {options.loraNames.length > LORA_RESULT_LIMIT && (
                              <div className="px-3 py-2 text-[11px] text-slate-500">
                                Showing first {LORA_RESULT_LIMIT} results
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <input
                        type="number"
                        step="0.05"
                        value={row.weight}
                        onChange={(event) =>
                          setLoraRows((rows) =>
                            rows.map((item) => (item.id === row.id ? { ...item, weight: event.target.value } : item))
                          )
                        }
                        className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
                        placeholder="Weight"
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveLora(row.id)}
                        className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-200 transition hover:border-rose-400/60 hover:text-white"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-slate-300">Trigger suggestions</div>
                        <button
                          type="button"
                          onClick={() => {
                            void handleInsertLoraTriggers(row.name);
                          }}
                          disabled={!hasLoraName}
                          className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Insert
                        </button>
                      </div>
                      {!hasLoraName ? (
                        <div className="mt-2 text-xs text-slate-500">Select a LoRA to load triggers.</div>
                      ) : rowTriggers.length === 0 ? (
                        <div className="mt-2 text-xs text-slate-500">No triggers</div>
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {rowTriggers.map((token) => {
                            const disabled = positiveTokenKeys.has(normalizeTokenKey(token));
                            return (
                              <button
                                key={token}
                                type="button"
                                onClick={() => insertPositiveTokens([token])}
                                disabled={disabled}
                                className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-100 transition hover:border-emerald-400/70 hover:text-white disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
                              >
                                {token}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 shadow-lg shadow-black/40">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">ControlNet</h2>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={controlnetEnabled}
                  onChange={(event) => setControlnetEnabled(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-emerald-400 focus:ring-emerald-400"
                />
                Enabled
              </label>
            </div>
            {controlnetEnabled ? (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm text-slate-300">Model</label>
                  <select
                    className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
                    disabled={isOptionDisabled(options.controlnetModelNames)}
                    value={controlnetModel}
                    onChange={(event) => setControlnetModel(event.target.value)}
                  >
                    <option value="">選択してください</option>
                    {options.controlnetModelNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-slate-300">Strength</label>
                  <input
                    type="number"
                    step="0.05"
                    value={controlnetStrength}
                    onChange={(event) => setControlnetStrength(event.target.value)}
                    className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
                    placeholder="1.0"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-slate-300">Image</label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(event) => setControlnetImageFile(event.target.files?.[0] ?? null)}
                    className="w-full text-sm text-slate-200 file:mr-3 file:rounded-md file:border file:border-slate-700 file:bg-slate-900 file:px-3 file:py-2 file:text-xs file:text-slate-200 file:transition hover:file:border-emerald-400/60 hover:file:text-white"
                  />
                  {controlnetImageFile && (
                    <p className="text-xs text-slate-400">Selected: {controlnetImageFile.name}</p>
                  )}
                  {!controlnetImageFile && defaults?.controlnetDefaults.imageName && (
                    <p className="text-xs text-slate-500">Template image: {defaults.controlnetDefaults.imageName}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="text-sm text-slate-300">Preprocessor</label>
                    <label className="ml-auto flex items-center gap-2 text-xs text-slate-400">
                      <input
                        type="checkbox"
                        checked={preprocessorEnabled}
                        onChange={(event) => setPreprocessorEnabled(event.target.checked)}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-emerald-400 focus:ring-emerald-400"
                      />
                      Use
                    </label>
                  </div>
                  <select
                    className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
                    disabled={!preprocessorEnabled || isOptionDisabled(options.preprocessorNames)}
                    value={preprocessor}
                    onChange={(event) => setPreprocessor(event.target.value)}
                  >
                    <option value="">選択してください</option>
                    {options.preprocessorNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-xs text-slate-500">Disabled. 必要なときだけ Enabled を ON にしてください。</p>
            )}
          </section>

        <details
          className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 shadow-lg shadow-black/40"
          open={ksamplerOpen}
          onToggle={(event) => setKsamplerOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-lg font-semibold">Advanced (KSampler)</summary>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm text-slate-300">Steps</label>
              <input
                type="number"
                value={ksamplerSteps}
                onChange={(event) => setKsamplerSteps(event.target.value)}
                className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-slate-300">CFG</label>
              <input
                type="number"
                step="0.1"
                value={ksamplerCfg}
                onChange={(event) => setKsamplerCfg(event.target.value)}
                className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-slate-300">Sampler</label>
              <input
                type="text"
                value={ksamplerSampler}
                onChange={(event) => setKsamplerSampler(event.target.value)}
                className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-slate-300">Scheduler</label>
              <input
                type="text"
                value={ksamplerScheduler}
                onChange={(event) => setKsamplerScheduler(event.target.value)}
                className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-slate-300">Seed</label>
              <input
                type="number"
                value={ksamplerSeed}
                onChange={(event) => setKsamplerSeed(event.target.value)}
                className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
              />
              <p className="text-xs text-slate-400">
                -1 は Muse 内部でランダム化として扱い、ComfyUI へは実seedを送ります。
              </p>
            </div>
          </div>
        </details>

        <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 shadow-lg shadow-black/40">
          <div className="space-y-3">
            <h2 className="text-lg font-semibold">Run</h2>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-emerald-500/60 bg-emerald-500/10 px-4 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting && (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-200/80 border-t-transparent" />
              )}
              <span>{isSubmitting ? "Running..." : "Run"}</span>
            </button>
          </div>
          <div className="mt-3 text-sm text-slate-300">
            {submitDebug.phase === "success" && (
              <p className="text-emerald-300">
                Run created: {submitDebug.lastRunId ?? "-"} (prompt_id: {submitDebug.lastPromptId ?? "-"})
              </p>
            )}
            {submitDebug.phase === "error" && <p className="text-rose-300">Error: {submitDebug.lastError ?? "-"}</p>}
            {submitDebug.phase === "submitting" && <p>送信中...</p>}
            {submitDebug.phase === "idle" && <p>入力を整えて Run を実行してください。</p>}
          </div>
        </section>
      </form>

      <TagDictionaryPanel dictionary={tagDictionary} onDictionaryChange={setTagDictionary} />

      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 shadow-lg shadow-black/40">
        <h2 className="text-lg font-semibold">Runs</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-separate border-spacing-y-2 text-sm">
            <thead className="text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 text-left">Created</th>
                <th className="px-3 text-left">Status</th>
                <th className="px-3 text-left">Checkpoint</th>
                <th className="px-3 text-left">Size</th>
                <th className="px-3 text-left">Prompt ID</th>
                <th className="px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-slate-400">
                    Runs がありません。
                  </td>
                </tr>
              )}
              {runs.map((run) => {
                const request = parseMaybeJson(run.request_json) ?? {};
                const history = parseMaybeJson(run.history_json) ?? {};
                const outputs = Array.isArray((history as any)?.outputs) ? ((history as any).outputs as RunOutput[]) : [];
                const firstOutput = outputs[0];
                const createdAt = formatTimestamp(run.created_at ?? (run as any).createdAt ?? null);
                const status = run.status ?? "-";
                const ckpt =
                  (request as any).ckptName ||
                  (request as any).ckpt_name ||
                  (request as any).checkpoint ||
                  (request as any).checkpointName ||
                  "-";
                const widthValue =
                  (request as any).width ?? (request as any).empty_latent_width ?? (request as any).emptyLatentWidth;
                const heightValue =
                  (request as any).height ?? (request as any).empty_latent_height ?? (request as any).emptyLatentHeight;
                const sizeText =
                  Number.isFinite(Number(widthValue)) && Number.isFinite(Number(heightValue))
                    ? `${widthValue} x ${heightValue}`
                    : "-";
                const promptId = run.prompt_id ?? "-";
                const isExpanded = !!expandedRuns[run.id];
                const viewUrl = firstOutput ? buildViewUrl(firstOutput) : null;
                return (
                  <Fragment key={run.id}>
                    <tr key={run.id} className="rounded-lg bg-slate-900/60">
                      <td className="px-3 py-3 text-slate-200">{createdAt}</td>
                      <td className="px-3 py-3">
                        <span className="rounded-full border border-slate-700 px-2 py-1 text-xs text-slate-200">
                          {status}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-slate-200">{ckpt}</td>
                      <td className="px-3 py-3 text-slate-200">{sizeText}</td>
                      <td className="px-3 py-3 text-slate-200">{promptId}</td>
                      <td className="px-3 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => toggleRun(run.id)}
                          className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
                        >
                          {isExpanded ? "Hide" : "Details"}
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${run.id}-details`} className="bg-slate-950/60">
                        <td colSpan={6} className="px-4 py-4">
                          <div className="grid gap-4 md:grid-cols-[180px_1fr]">
                            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-2">
                              {viewUrl ? (
                                <img
                                  src={viewUrl}
                                  alt="output thumbnail"
                                  className="h-auto w-full rounded-md object-cover"
                                />
                              ) : (
                                <div className="flex h-28 items-center justify-center text-xs text-slate-500">
                                  No image
                                </div>
                              )}
                              {viewUrl && (
                                <a
                                  href={viewUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-2 block text-xs text-emerald-300 hover:text-emerald-200"
                                >
                                  Open image
                                </a>
                              )}
                            </div>
                            <div className="space-y-3">
                              {run.error_message && (
                                <div className="rounded-md border border-rose-900/50 bg-rose-500/10 p-3 text-xs text-rose-200">
                                  {run.error_message}
                                </div>
                              )}
                              <div className="flex flex-wrap gap-3 text-xs text-slate-400">
                                <span>updated: {formatTimestamp(run.updated_at ?? null)}</span>
                                <span>started: {formatTimestamp(run.started_at ?? null)}</span>
                                <span>finished: {formatTimestamp(run.finished_at ?? null)}</span>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleDeleteRun(run.id)}
                                className="rounded-md border border-rose-400/60 px-3 py-2 text-xs text-rose-200 transition hover:border-rose-300 hover:text-rose-100"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 shadow-lg shadow-black/40">
        <h2 className="text-lg font-semibold">Runs Debug</h2>
        <div className="mt-3 grid gap-3 text-sm text-slate-200">
          <div className="flex flex-wrap gap-4">
            <span>attempt: {runsDebug.attempt}</span>
            <span>phase: {runsDebug.phase}</span>
            <span>lastUpdatedAt: {runsDebug.lastUpdatedAt ?? "-"}</span>
          </div>
          <div className="flex flex-wrap gap-4">
            <span>lastError: {runsDebug.lastError ?? "-"}</span>
            <span>lastHttpStatus: {runsDebug.lastHttpStatus ?? "-"}</span>
          </div>
          <div>
            <p className="text-xs text-slate-400">lastRawText (short)</p>
            <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-300">
              {runsDebug.lastRawText ?? "-"}
            </pre>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 shadow-lg shadow-black/40">
        <h2 className="text-lg font-semibold">Options Debug</h2>
        <div className="mt-3 grid gap-3 text-sm text-slate-200">
          <div className="flex flex-wrap gap-4">
            <span>attempt: {debug.attempt}</span>
            <span>phase: {debug.phase}</span>
            <span>lastUpdatedAt: {debug.lastUpdatedAt ?? "-"}</span>
          </div>
          <div className="flex flex-wrap gap-4">
            <span>lastError: {debug.lastError ?? "-"}</span>
            <span>lastRequestUrl: {debug.lastRequestUrl ?? "-"}</span>
            <span>lastHttpStatus: {debug.lastHttpStatus ?? "-"}</span>
          </div>
          <div className="text-xs text-slate-400">
            defaults:{" "}
            {defaults
              ? `ckpt=${defaults.efficientLoaderDefaults.ckptName || "-"}, size=${defaults.efficientLoaderDefaults.width}x${defaults.efficientLoaderDefaults.height}, loraCount=${defaults.loraDefaults.length}, controlnetEnabled=${defaults.controlnetDefaults.enabled}, ksampler=${defaults.ksamplerDefaults.steps}/${defaults.ksamplerDefaults.cfg}/${defaults.ksamplerDefaults.sampler_name || "-"} / ${defaults.ksamplerDefaults.scheduler || "-"} / ${defaults.ksamplerDefaults.denoise} / seed=${defaults.ksamplerDefaults.seed}`
              : "-"}
          </div>
          <div>
            <p className="text-xs text-slate-400">lastRawText (short)</p>
            <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-300">
              {debug.lastRawText ?? "-"}
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
}
