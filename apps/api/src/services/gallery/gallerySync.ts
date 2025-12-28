const toStringOrNull = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

const toNumberOrNull = (value: unknown) => {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
};

const uniqStrings = (values: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

const compactRecord = (record: Record<string, unknown>) => {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    next[key] = value;
  }
  return next;
};

export type GalleryRunSource = {
  id: string;
  prompt_id?: string | null;
  request_json?: unknown;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
  finished_at?: string | Date | null;
};

export type ComfyOutputImage = {
  filename: string;
  subfolder?: string | null;
  type?: string | null;
};

export type GallerySyncItem = {
  sourceType: "comfy_run";
  comfyRunId: string;
  promptId: string | null;
  filename: string;
  subfolder: string | null;
  fileType: string | null;
  width: number | null;
  height: number | null;
  ckptName: string | null;
  loraNames: string[] | null;
  positive: string | null;
  negative: string | null;
  createdAt: string | Date | null;
  meta: Record<string, unknown>;
  metaExtracted: Record<string, unknown>;
  needsReview: boolean;
};

const extractLoraNames = (value: unknown) => {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const enabled =
      record.enabled === undefined ? true : typeof record.enabled === "boolean" ? record.enabled : Boolean(record.enabled);
    if (!enabled) continue;
    const name = toStringOrNull(record.name ?? record.lora_name ?? record.loraName);
    if (name) {
      names.push(name);
    }
  }
  const unique = uniqStrings(names);
  return unique.length > 0 ? unique : null;
};

const extractRequestSummary = (request: Record<string, unknown>) => {
  const controlnet = compactRecord({
    enabled: typeof request.controlnetEnabled === "boolean" ? request.controlnetEnabled : undefined,
    model: toStringOrNull(request.controlnetModel),
    preprocessorEnabled: typeof request.preprocessorEnabled === "boolean" ? request.preprocessorEnabled : undefined,
    preprocessor: toStringOrNull(request.preprocessor),
    strength: toNumberOrNull(request.controlnetStrength)
  });

  return compactRecord({
    workflowId: toStringOrNull(request.workflowId),
    controlnet,
    ksampler: request.ksampler ?? undefined,
    initImage: toStringOrNull(request.initImage),
    controlnetImage: toStringOrNull(request.controlnetImage)
  });
};

export const buildGalleryItemsFromRun = (run: GalleryRunSource, outputs: ComfyOutputImage[]): GallerySyncItem[] => {
  if (!run || outputs.length === 0) return [];
  const request = run.request_json && typeof run.request_json === "object" ? (run.request_json as Record<string, unknown>) : {};
  const createdAt = run.finished_at ?? run.updated_at ?? run.created_at ?? null;

  const width = toNumberOrNull(request.width);
  const height = toNumberOrNull(request.height);
  const ckptName = toStringOrNull(request.ckptName);
  const positive = toStringOrNull(request.positive);
  const negative = toStringOrNull(request.negative);
  const loraNames = extractLoraNames(request.loras);
  const requestSummary = extractRequestSummary(request);
  const meta = compactRecord({
    request: requestSummary,
    history: { outputsCount: outputs.length }
  });
  const metaExtracted: Record<string, unknown> = {};

  const promptId = toStringOrNull(run.prompt_id ?? null);
  return outputs.map((output) => ({
    sourceType: "comfy_run",
    comfyRunId: run.id,
    promptId,
    filename: output.filename,
    subfolder: output.subfolder ?? null,
    fileType: output.type ?? null,
    width,
    height,
    ckptName,
    loraNames,
    positive,
    negative,
    createdAt,
    meta,
    metaExtracted,
    needsReview: false
  }));
};
