import cors from "cors";
import express from "express";
import multer, { type FileFilterCallback } from "multer";
import { randomInt, randomUUID } from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Pool, PoolClient } from "pg";
import { z } from "zod";
import { parse } from "csv-parse";
import { comfyService } from "../services/comfyService.js";
import {
  getGalleryItemById,
  listGalleryItems,
  updateGalleryExtractedFields,
  updateGalleryFavorite,
  updateGalleryManualFields,
  deleteGalleryItem,
  upsertGalleryItems,
  type GalleryFilters
} from "../services/gallery/galleryRepo.js";
import {
  createGallerySource,
  deleteGallerySource,
  getGallerySourceById,
  listGallerySources,
  updateGallerySource
} from "../services/gallery/gallerySourcesRepo.js";
import { scanGallerySource } from "../services/gallery/galleryScan.js";
import { buildGalleryItemsFromRun } from "../services/gallery/gallerySync.js";
import { extractImageMetadata } from "../services/gallery/metadataExtract.js";
import { getComfyPaths, getComfyWorkflowPaths, getWorkshopPaths, resolveMediaPath } from "../services/storage/storagePaths.js";
import { WHISPER_LANGUAGES, whisperService } from "../services/whisperService.js";
import type { AppContext } from "./context.js";

export const registerRoutes = (app: express.Express, context: AppContext) => {
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 300000);
const OLLAMA_TEMPERATURE = Number.isFinite(Number(process.env.OLLAMA_TEMPERATURE))
  ? Number(process.env.OLLAMA_TEMPERATURE)
  : 0.9;
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "5m";
const DEFAULT_LLM_MODEL = (process.env.DEFAULT_LLM_MODEL || "gpt-oss:20b").trim();
const OLLAMA_TRANSLATE_MODEL = (process.env.OLLAMA_TRANSLATE_MODEL || "gpt-oss:20b").trim();
const OLLAMA_NUM_GPU = Number.isFinite(Number(process.env.OLLAMA_NUM_GPU))
  ? Number(process.env.OLLAMA_NUM_GPU)
  : undefined;
const COMFY_BASE_URL = (process.env.COMFY_BASE_URL || "http://127.0.0.1:8188").trim().replace(/\/+$/, "");
const COMFY_OBJECT_INFO_TIMEOUT_MS = 4000;
const COMFY_OBJECT_INFO_CACHE_TTL_MS = 60_000;
const COMFY_REQUEST_TIMEOUT_MS = 8000;
const COMFY_HISTORY_GRACE_MS = Number.isFinite(Number(process.env.COMFY_HISTORY_GRACE_MS))
  ? Number(process.env.COMFY_HISTORY_GRACE_MS)
  : 600_000;
const COMFY_TAGGER_POLL_INTERVAL_MS = 2000;
const COMFY_TAGGER_POLL_TIMEOUT_MS = 60_000;
const { root: WORKSHOP_ROOT, recipeThumbsDir: RECIPE_THUMBS_DIR, loraThumbsDir: LORA_THUMBS_DIR } = getWorkshopPaths();
const {
  taggerInputsDir: COMFY_TAGGER_INPUTS_DIR
} = getComfyPaths();
const {
  text2i: COMFY_WORKFLOW_TEXT2I_PATH,
  image2i: COMFY_WORKFLOW_IMAGE2I_PATH,
  tagger: COMFY_WORKFLOW_TAGGER_PATH
} = getComfyWorkflowPaths();

type Queryable = Pool | PoolClient;

const pool = context.pool;

const ALLOWED_IMAGE_MIME = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"]
]);

const resolveImageExtension = (file: Express.Multer.File) => {
  const ext = ALLOWED_IMAGE_MIME.get(file.mimetype) ?? path.extname(file.originalname).replace(/^\.+/, "");
  if (!ext) return ".bin";
  return ext.startsWith(".") ? ext : `.${ext}`;
};

const COMFY_INPUT_SUBDIRS = new Set(["tagger_inputs", "init_images", "control_images"]);

const normalizeComfyInputRoot = (value: string) => {
  const root = path.resolve(value);
  const leaf = path.basename(root).toLowerCase();
  if (COMFY_INPUT_SUBDIRS.has(leaf)) {
    return path.dirname(root);
  }
  return root;
};

const resolveComfyInputRoot = () => {
  const config = comfyService.getConfig();
  const args = config.extraArgs ?? [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--input-directory" && args[i + 1]) {
      return normalizeComfyInputRoot(args[i + 1]);
    }
    if (arg.startsWith("--input-directory=")) {
      return normalizeComfyInputRoot(arg.slice("--input-directory=".length));
    }
  }
  if (config.dir) {
    return normalizeComfyInputRoot(path.resolve(config.dir, "input"));
  }
  return normalizeComfyInputRoot(path.resolve(path.dirname(COMFY_TAGGER_INPUTS_DIR)));
};

const resolveComfyDefaultInputRoot = () => {
  const config = comfyService.getConfig();
  if (!config.dir) return null;
  return normalizeComfyInputRoot(path.resolve(config.dir, "input"));
};

const resolveComfyInputPaths = (inputRoot: string, subdir: string, filename: string) => {
  const root = normalizeComfyInputRoot(inputRoot);
  return { dir: path.join(root, subdir), name: path.posix.join(subdir, filename) };
};

const writeComfyInputFile = async (subdir: string, filename: string, buffer: Buffer) => {
  const inputRoot = resolveComfyInputRoot();
  const primary = resolveComfyInputPaths(inputRoot, subdir, filename);
  await fs.promises.mkdir(primary.dir, { recursive: true });
  await fs.promises.writeFile(path.join(primary.dir, filename), buffer);

  const fallbackRoot = resolveComfyDefaultInputRoot();
  if (fallbackRoot && path.resolve(fallbackRoot) !== path.resolve(inputRoot)) {
    const fallback = resolveComfyInputPaths(fallbackRoot, subdir, filename);
    if (path.resolve(fallback.dir) !== path.resolve(primary.dir)) {
      await fs.promises.mkdir(fallback.dir, { recursive: true });
      await fs.promises.writeFile(path.join(fallback.dir, filename), buffer);
    }
  }

  return primary.name;
};

const encodeMediaKey = (value: string) =>
  value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const TAG_DICTIONARY_CSV_MAX_BYTES = 50 * 1024 * 1024;
const TAG_DICTIONARY_TMP_DIR = path.join(os.tmpdir(), "cg-muse");
fs.mkdirSync(TAG_DICTIONARY_TMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req: express.Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    if (ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type"));
    }
  }
});

const whisperUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

const tagDictionaryUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, TAG_DICTIONARY_TMP_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").trim() || ".csv";
      cb(null, `tag_dictionary_${Date.now()}_${randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: TAG_DICTIONARY_CSV_MAX_BYTES }
});

const runMulterSingle = (req: express.Request, res: express.Response) =>
  new Promise<void>((resolve, reject) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) return reject(err);
      resolve();
    });
  });

const runWhisperUpload = (req: express.Request, res: express.Response) =>
  new Promise<void>((resolve, reject) => {
    whisperUpload.single("file")(req, res, (err: unknown) => {
      if (err) return reject(err);
      resolve();
    });
  });

const runCsvUpload = (req: express.Request, res: express.Response) =>
  new Promise<void>((resolve, reject) => {
    csvUpload.single("file")(req, res, (err: unknown) => {
      if (err) return reject(err);
      resolve();
    });
  });

const runTagDictionaryUpload = (req: express.Request, res: express.Response) =>
  new Promise<void>((resolve, reject) => {
    tagDictionaryUpload.single("file")(req, res, (err: unknown) => {
      if (err) return reject(err);
      resolve();
    });
  });

const runComfyRunUpload = (req: express.Request, res: express.Response) =>
  new Promise<void>((resolve, reject) => {
    upload.fields([
      { name: "controlnetImage", maxCount: 1 },
      { name: "initImage", maxCount: 1 }
    ])(req, res, (err: unknown) => {
      if (err) return reject(err);
      resolve();
    });
  });

const runComfyTaggerUpload = (req: express.Request, res: express.Response) =>
  new Promise<void>((resolve, reject) => {
    upload.single("image")(req, res, (err: unknown) => {
      if (err) return reject(err);
      resolve();
    });
  });

const deleteFileSafe = async (key?: string | null) => {
  if (!key) return;
  const filePath = resolveMediaPath(key);
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (err: any) {
    if (err && typeof err === "object" && "code" in err && (err as any).code === "ENOENT") {
      return;
    }
    console.error("Failed to delete file", filePath, err);
  }
};

app.use(
  cors({
    origin: "http://localhost:5173",
  })
);
app.use(express.json());
app.use("/media", express.static(WORKSHOP_ROOT));

const respondError = (
  res: express.Response,
  status: number,
  message: string,
  details?: Record<string, unknown>
) => res.status(status).json({ ok: false, error: { message, ...(details ? { details } : {}) } });

const asyncHandler =
  <T extends express.RequestHandler>(fn: T): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const truncateText = (text: string, limit = 50_000) => {
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
};

const extractJsonPayload = (text: string) => {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fallback below
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
};

type ComfyObjectInfoError = {
  message: string;
  details?: Record<string, unknown>;
};

type ComfyObjectInfoResult =
  | { ok: true; nodeClass: string; objectInfo: unknown }
  | { ok: false; nodeClass: string; error: ComfyObjectInfoError };

type ComfyPartialError = {
  nodeClass: string;
  message: string;
  details?: Record<string, unknown>;
};

const objectInfoCache = new Map<string, { expiresAt: number; value: unknown }>();
const translateCache = new Map<string, { expiresAt: number; value: string }>();
const TRANSLATE_CACHE_TTL_MS = 10 * 60_000;
const TAG_CSV_BATCH_SIZE = 1000;
const TAG_CSV_ERRORS_SAMPLE_LIMIT = 20;

const safeDecodeURIComponent = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeStringList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => normalizeStringList(item))
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
};

const parseGalleryCursor = (cursorRaw: string) => {
  const parts = cursorRaw.split("|");
  if (parts.length !== 2) return null;
  const [createdAtRaw, idRaw] = parts;
  const parsedTime = Date.parse(createdAtRaw);
  if (Number.isNaN(parsedTime)) return null;
  const idParsed = z.string().uuid().safeParse(idRaw.trim());
  if (!idParsed.success) return null;
  return { createdAt: new Date(parsedTime).toISOString(), id: idParsed.data };
};

const parseDateParam = (value: string) => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
};

const resolveAbsolutePath = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!path.isAbsolute(trimmed)) return null;
  return path.resolve(trimmed);
};

const buildComfyViewUrl = (item: {
  id: string;
  source_type?: string | null;
  filename: string;
  subfolder?: string | null;
  file_type?: string | null;
}) => {
  if (item.source_type === "folder") {
    return `/api/gallery/items/${item.id}/file`;
  }
  const params = new URLSearchParams({ filename: item.filename });
  if (item.subfolder) params.set("subfolder", item.subfolder);
  if (item.file_type) params.set("type", item.file_type);
  return `/api/comfy/view?${params.toString()}`;
};

const mapGalleryItem = (item: any) => ({
  ...item,
  ckpt_name: item.manual_ckpt_name ?? item.ckpt_name,
  lora_names: item.manual_lora_names ?? item.lora_names,
  positive: item.manual_positive ?? item.positive,
  negative: item.manual_negative ?? item.negative,
  width: item.manual_width ?? item.width,
  height: item.manual_height ?? item.height,
  extracted_ckpt_name: item.ckpt_name,
  extracted_lora_names: item.lora_names,
  extracted_positive: item.positive,
  extracted_negative: item.negative,
  extracted_width: item.width,
  extracted_height: item.height
});

const extractStringArray = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const extractOptionValues = (value: unknown): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    if (Array.isArray(value[0])) {
      return extractStringArray(value[0]);
    }
    const nested = value.flatMap((item) => extractOptionValues(item));
    if (nested.length > 0) return nested;
    return extractStringArray(value);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = ["choices", "values", "options", "items", "enum", "allowed", "list"];
    for (const key of keys) {
      if (Array.isArray(record[key])) {
        return extractStringArray(record[key]);
      }
    }
  }
  return [];
};

const uniqStrings = (values: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
};

const resolveObjectInfo = (payload: unknown, nodeClass: string) => {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  if (record[nodeClass]) return record[nodeClass];
  if (record.objectInfo && typeof record.objectInfo === "object") return record.objectInfo;
  if (record.data && typeof record.data === "object") {
    const dataRecord = record.data as Record<string, unknown>;
    if (dataRecord.objectInfo && typeof dataRecord.objectInfo === "object") return dataRecord.objectInfo;
  }
  return payload;
};

const collectChoicesByKey = (payload: unknown, matcher: (key: string) => boolean) => {
  const collected: string[] = [];
  const visited = new Set<object>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (visited.has(value as object)) return;
    visited.add(value as object);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (matcher(key)) {
        collected.push(...extractOptionValues(val));
      }
      walk(val);
    }
  };
  walk(payload);
  return uniqStrings(collected);
};

const fetchComfyObjectInfo = async (nodeClass: string, useCache = false): Promise<ComfyObjectInfoResult> => {
  if (useCache) {
    const cached = objectInfoCache.get(nodeClass);
    if (cached && cached.expiresAt > Date.now()) {
      return { ok: true, nodeClass, objectInfo: cached.value };
    }
  }

  const url = `${COMFY_BASE_URL}/object_info/${encodeURIComponent(nodeClass)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), COMFY_OBJECT_INFO_TIMEOUT_MS);
  let body = "";

  try {
    const response = await fetch(url, { signal: controller.signal });
    body = await response.text();
    let parsed: unknown = null;
    if (body.trim()) {
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        return {
          ok: false,
          nodeClass,
          error: {
            message: "invalid_json",
            details: { error: err instanceof Error ? err.message : String(err), body: truncateText(body) }
          }
        };
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        nodeClass,
        error: { message: "upstream_error", details: { status: response.status, body: truncateText(body) } }
      };
    }

    if (parsed && typeof parsed === "object" && (parsed as any).ok === false) {
      const errorData = (parsed as any).error;
      return {
        ok: false,
        nodeClass,
        error: {
          message: (errorData && typeof errorData.message === "string" && errorData.message) || "comfy_error",
          details: (errorData && typeof errorData === "object" ? errorData : { raw: errorData }) as Record<string, unknown>
        }
      };
    }

    if (!parsed) {
      return { ok: false, nodeClass, error: { message: "empty_response" } };
    }

    const objectInfo = resolveObjectInfo(parsed, nodeClass);
    if (useCache) {
      objectInfoCache.set(nodeClass, { expiresAt: Date.now() + COMFY_OBJECT_INFO_CACHE_TTL_MS, value: objectInfo });
    }
    return { ok: true, nodeClass, objectInfo };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      nodeClass,
      error: {
        message: isTimeout ? "timeout" : "comfy_unreachable",
        details: { error: err instanceof Error ? err.message : String(err) }
      }
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

type ComfyRunStatus = "created" | "queued" | "running" | "succeeded" | "failed" | "blocked" | "stale";

type ComfyOutputImage = {
  filename: string;
  subfolder?: string | null;
  type?: string | null;
  nodeId?: string | null;
};

type ComfyTemplateDefaults = {
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

type ComfyFetchResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { message: string; details?: Record<string, unknown> } };

const parseBoolean = (value: unknown, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
};

const parseOptionalBoolean = (value: unknown) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return null;
};

const parseJsonPayload = (value: unknown) => {
  if (value === undefined || value === null || value === "") {
    return { ok: true as const, value: undefined };
  }
  if (typeof value !== "string") {
    return { ok: true as const, value };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true as const, value: undefined };
  }
  try {
    return { ok: true as const, value: JSON.parse(trimmed) };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
};

const fetchComfyJson = async (
  endpoint: string,
  options: RequestInit,
  timeoutMs: number
): Promise<ComfyFetchResult> => {
  const url = `${COMFY_BASE_URL}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let body = "";

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    body = await response.text();
    let parsed: unknown = null;
    if (body.trim()) {
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        return {
          ok: false,
          error: {
            message: "invalid_json",
            details: { error: err instanceof Error ? err.message : String(err), body: truncateText(body) }
          }
        };
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        error: { message: "upstream_error", details: { status: response.status, body: truncateText(body) } }
      };
    }

    return { ok: true, data: parsed };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: {
        message: isTimeout ? "timeout" : "comfy_unreachable",
        details: { error: err instanceof Error ? err.message : String(err) }
      }
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

const readWorkflowTemplate = async (templatePath: string) => {
  const raw = await fs.promises.readFile(templatePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Workflow template is invalid");
  }
  return parsed;
};

const getNodeInputs = (workflow: Record<string, any>, nodeId: string, label: string) => {
  const node = workflow[nodeId];
  if (!node || typeof node !== "object" || typeof node.inputs !== "object") {
    throw new Error(`Workflow node ${label} (${nodeId}) is missing`);
  }
  return node.inputs as Record<string, any>;
};

let comfyDefaultsCache: ComfyTemplateDefaults | null = null;
let comfyImage2iDefaultsCache: ComfyImage2iDefaults | null = null;

const toNumberValue = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toStringValue = (value: unknown) => (typeof value === "string" ? value : "");

const getComfyTemplateDefaults = async (): Promise<ComfyTemplateDefaults> => {
  if (comfyDefaultsCache) return comfyDefaultsCache;

  const workflow = await readWorkflowTemplate(COMFY_WORKFLOW_TEXT2I_PATH);
  const loaderInputs = getNodeInputs(workflow, "91", "Efficient Loader");
  const loraInputs = getNodeInputs(workflow, "92", "LoRA Stacker");
  const controlNetLoaderInputs = getNodeInputs(workflow, "83", "ControlNetLoader");
  const preprocessorInputs = getNodeInputs(workflow, "112", "ControlNetPreprocessorSelector");
  const controlNetStackInputs = getNodeInputs(workflow, "104", "Control Net Stacker");
  const samplerInputs = getNodeInputs(workflow, "3", "KSampler (Efficient)");
  const loadImageInputs = getNodeInputs(workflow, "114", "LoadImage");

  const loraCount = Math.max(0, Math.trunc(toNumberValue(loraInputs.lora_count, 0)));
  const loraDefaults: { name: string; weight: number }[] = [];
  for (let i = 1; i <= loraCount; i += 1) {
    const name = toStringValue(loraInputs[`lora_name_${i}`]);
    const weight = toNumberValue(loraInputs[`lora_wt_${i}`], 1);
    loraDefaults.push({ name, weight });
  }

  const strength = toNumberValue(controlNetStackInputs.strength, 0);

  comfyDefaultsCache = {
    efficientLoaderDefaults: {
      ckptName: toStringValue(loaderInputs.ckpt_name),
      positive: toStringValue(loaderInputs.positive),
      negative: toStringValue(loaderInputs.negative),
      width: Math.trunc(toNumberValue(loaderInputs.empty_latent_width, 0)),
      height: Math.trunc(toNumberValue(loaderInputs.empty_latent_height, 0))
    },
    loraDefaults,
    controlnetDefaults: {
      modelName: toStringValue(controlNetLoaderInputs.control_net_name),
      preprocessor: toStringValue(preprocessorInputs.preprocessor),
      strength,
      enabled: strength > 0,
      imageName: toStringValue(loadImageInputs.image) || null
    },
    ksamplerDefaults: {
      steps: Math.trunc(toNumberValue(samplerInputs.steps, 0)),
      cfg: toNumberValue(samplerInputs.cfg, 0),
      sampler_name: toStringValue(samplerInputs.sampler_name || samplerInputs.sampler),
      scheduler: toStringValue(samplerInputs.scheduler),
      denoise: toNumberValue(samplerInputs.denoise, 0),
      seed: -1
    }
  };

  return comfyDefaultsCache;
};

const getComfyImage2iDefaults = async (): Promise<ComfyImage2iDefaults> => {
  if (comfyImage2iDefaultsCache) return comfyImage2iDefaultsCache;

  const workflow = await readWorkflowTemplate(COMFY_WORKFLOW_IMAGE2I_PATH);
  const samplerInputs = getNodeInputs(workflow, "3", "KSampler (Efficient)");

  comfyImage2iDefaultsCache = {
    ksamplerDenoiseDefault: toNumberValue(samplerInputs.denoise, 0)
  };

  return comfyImage2iDefaultsCache;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const readOptionalString = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const readOptionalNumber = (value: unknown) => {
  if (value === undefined || value === null || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
};

const readOptionalBoolean = (value: unknown) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return undefined;
};

const getRecipeComfyConfig = (variables: unknown): Record<string, unknown> => {
  const record = asRecord(variables);
  if (!record) return {};
  const candidates = ["comfy", "comfyRun", "comfy_run", "comfyParams", "comfy_params"];
  for (const key of candidates) {
    const nested = asRecord(record[key]);
    if (nested) return nested;
  }
  return record;
};

const updateLoraStack = (inputs: Record<string, any>, loras: { name: string; weight: number; enabled: boolean }[]) => {
  const enabled = loras.filter((item) => item.enabled && item.name.trim().length > 0);
  const maxSlots = 50;
  const existingCount = Number.isFinite(Number(inputs.lora_count)) ? Math.max(0, Math.trunc(inputs.lora_count)) : 0;
  const loraCount = Math.min(Math.max(existingCount, enabled.length), maxSlots);
  if (loraCount > 0) {
    inputs.lora_count = loraCount;
  }

  for (let i = 1; i <= maxSlots; i += 1) {
    const entry = enabled[i - 1];
    if (entry) {
      inputs[`lora_name_${i}`] = entry.name;
      inputs[`lora_wt_${i}`] = Number.isFinite(entry.weight) ? entry.weight : 1;
    } else {
      inputs[`lora_name_${i}`] = "None";
      inputs[`lora_wt_${i}`] = 1;
    }
  }
};

const applyWorkflowOverrides = (
  workflow: Record<string, any>,
  params: {
    mode: "text2i" | "image2i";
    positive: string;
    negative: string;
    ckptName: string;
    width: number;
    height: number;
    loras: { name: string; weight: number; enabled: boolean }[];
    controlnetEnabled: boolean;
    controlnetModel?: string;
    preprocessorEnabled: boolean;
    preprocessor?: string;
    controlnetStrength?: number;
    ksampler?: {
      steps?: number;
      cfg?: number;
      sampler?: string;
      sampler_name?: string;
      scheduler?: string;
      seed?: number;
      denoise?: number;
    };
    controlnetImageName?: string | null;
    initImageName?: string | null;
  }
) => {
  const loaderNodeId = params.mode === "image2i" ? "122" : "91";
  const loaderInputs = getNodeInputs(workflow, loaderNodeId, "Efficient Loader");
  loaderInputs.ckpt_name = params.ckptName;
  loaderInputs.positive = params.positive;
  loaderInputs.negative = params.negative;
  if (params.mode === "text2i") {
    loaderInputs.empty_latent_width = params.width;
    loaderInputs.empty_latent_height = params.height;
  }

  const loraInputs = getNodeInputs(workflow, "92", "LoRA Stacker");
  updateLoraStack(loraInputs, params.loras);

  if (params.ksampler) {
    const samplerInputs = getNodeInputs(workflow, "3", "KSampler (Efficient)");
    if (params.ksampler.steps !== undefined) samplerInputs.steps = params.ksampler.steps;
    if (params.ksampler.cfg !== undefined) samplerInputs.cfg = params.ksampler.cfg;
    if (params.ksampler.scheduler !== undefined) samplerInputs.scheduler = params.ksampler.scheduler;
    if (params.ksampler.seed !== undefined) samplerInputs.seed = params.ksampler.seed;
    if (params.ksampler.denoise !== undefined && params.mode === "image2i") {
      samplerInputs.denoise = params.ksampler.denoise;
    }
    if (params.ksampler.sampler_name) {
      samplerInputs.sampler_name = params.ksampler.sampler_name;
    } else if (params.ksampler.sampler) {
      samplerInputs.sampler_name = params.ksampler.sampler;
    }
  }

  if (params.mode === "image2i" && params.initImageName) {
    const initImageInputs = getNodeInputs(workflow, "117", "LoadImage (init)");
    initImageInputs.image = params.initImageName;
  }

  const controlNetStackInputs = getNodeInputs(workflow, "104", "Control Net Stacker");
  if (!params.controlnetEnabled) {
    controlNetStackInputs.strength = 0;
    return;
  }

  const controlNetLoaderInputs = getNodeInputs(workflow, "83", "ControlNetLoader");
  if (params.controlnetModel) {
    controlNetLoaderInputs.control_net_name = params.controlnetModel;
  }

  if (params.preprocessorEnabled && params.preprocessor) {
    const preprocessorInputs = getNodeInputs(workflow, "112", "ControlNetPreprocessorSelector");
    preprocessorInputs.preprocessor = params.preprocessor;
  }

  if (params.controlnetStrength !== undefined) {
    controlNetStackInputs.strength = params.controlnetStrength;
  }

  if (params.controlnetImageName) {
    const loadImageInputs = getNodeInputs(workflow, "114", "LoadImage");
    loadImageInputs.image = params.controlnetImageName;
  }
};

type ComfyRunCreateResult =
  | { ok: true; run: any }
  | { ok: false; error: { status: number; message: string; details?: Record<string, unknown> } };

const createComfyRun = async (
  input: ComfyRunCreateInput,
  options: {
    controlnetFile?: Express.Multer.File;
    initImageFile?: Express.Multer.File;
    controlnetImageName?: string | null;
    initImageName?: string | null;
    recipeId?: string | null;
    recipeSnapshot?: Record<string, unknown> | null;
  }
): Promise<ComfyRunCreateResult> => {
  const runId = randomUUID();
  let controlnetImageName = options.controlnetImageName ?? null;
  let initImageName = options.initImageName ?? null;

  if (options.initImageFile) {
    const safeExt = resolveImageExtension(options.initImageFile);
    const initFile = `init_${runId}_${Date.now()}${safeExt}`;
    initImageName = await writeComfyInputFile("init_images", initFile, options.initImageFile.buffer);
  }

  if (options.controlnetFile && input.controlnetEnabled) {
    const safeExt = resolveImageExtension(options.controlnetFile);
    const controlFile = `controlnet_${runId}_${Date.now()}${safeExt}`;
    controlnetImageName = await writeComfyInputFile("control_images", controlFile, options.controlnetFile.buffer);
  }

  const useImage2i = input.workflowId === "base_image2i";
  if (useImage2i && !initImageName) {
    return { ok: false, error: { status: 400, message: "initImage is required for image2i" } };
  }

  let workflow: Record<string, any>;
  let resolvedSeed: number | null = null;
  const ksamplerForWorkflow = input.ksampler ? { ...input.ksampler } : undefined;
  if (ksamplerForWorkflow?.seed !== undefined && ksamplerForWorkflow.seed === -1) {
    resolvedSeed = randomInt(0, 2147483648);
    ksamplerForWorkflow.seed = resolvedSeed;
  }
  const templatePath = useImage2i ? COMFY_WORKFLOW_IMAGE2I_PATH : COMFY_WORKFLOW_TEXT2I_PATH;
  try {
    workflow = await readWorkflowTemplate(templatePath);
    applyWorkflowOverrides(workflow, {
      ...input,
      mode: useImage2i ? "image2i" : "text2i",
      ksampler: ksamplerForWorkflow,
      loras: input.loras.map((item) => ({
        name: item.name,
        weight: item.weight ?? 1,
        enabled: item.enabled ?? true
      })),
      controlnetImageName,
      initImageName
    });
  } catch (err) {
    return {
      ok: false,
      error: { status: 500, message: "Failed to prepare workflow", details: { error: err instanceof Error ? err.message : String(err) } }
    };
  }

  const requestPayload: Record<string, unknown> = {
    workflowId: input.workflowId,
    positive: input.positive,
    negative: input.negative,
    ckptName: input.ckptName,
    width: input.width,
    height: input.height,
    loras: input.loras,
    controlnetEnabled: input.controlnetEnabled,
    controlnetModel: input.controlnetModel ?? null,
    preprocessorEnabled: input.preprocessorEnabled,
    preprocessor: input.preprocessor ?? null,
    controlnetStrength: input.controlnetStrength ?? null,
    ksampler: input.ksampler ?? null,
    ...(resolvedSeed !== null ? { ksamplerResolved: { seed: resolvedSeed } } : {}),
    controlnetImage: controlnetImageName ?? null,
    ...(initImageName ? { initImage: initImageName } : {})
  };
  if (options.recipeId) requestPayload.recipeId = options.recipeId;
  if (options.recipeSnapshot) requestPayload.recipeSnapshot = options.recipeSnapshot;

  await pool.query(
    `INSERT INTO comfy_runs (id, status, prompt_id, request_json, workflow_json, history_json, error_message, recipe_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [runId, "created", null, requestPayload, workflow, null, null, options.recipeId ?? null]
  );

  const promptResult = await fetchComfyJson(
    "/prompt",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow })
    },
    COMFY_REQUEST_TIMEOUT_MS
  );

  if (!promptResult.ok) {
    const errorMessage = promptResult.error.message;
    await pool.query(
      `UPDATE comfy_runs
       SET status = $1, error_message = $2, updated_at = NOW(), finished_at = NOW()
       WHERE id = $3
       RETURNING *`,
      ["failed", errorMessage, runId]
    );
    const status = errorMessage === "timeout" ? 504 : 502;
    return {
      ok: false,
      error: { status, message: errorMessage, details: { runId, ...(promptResult.error.details ? { details: promptResult.error.details } : {}) } }
    };
  }

  if (promptResult.data && typeof promptResult.data === "object" && (promptResult.data as any).error) {
    const errorValue = (promptResult.data as any).error;
    const errorMessage =
      errorValue && typeof errorValue === "object" && typeof errorValue.message === "string"
        ? errorValue.message
        : typeof errorValue === "string"
          ? errorValue
          : "prompt_error";
    await pool.query(
      `UPDATE comfy_runs
       SET status = $1, error_message = $2, updated_at = NOW(), finished_at = NOW()
       WHERE id = $3
       RETURNING *`,
      ["failed", errorMessage, runId]
    );
    return { ok: false, error: { status: 502, message: errorMessage, details: { runId } } };
  }

  const promptId =
    promptResult.data && typeof promptResult.data === "object" && (promptResult.data as any).prompt_id
      ? String((promptResult.data as any).prompt_id)
      : "";

  if (!promptId) {
    await pool.query(
      `UPDATE comfy_runs
       SET status = $1, error_message = $2, updated_at = NOW(), finished_at = NOW()
       WHERE id = $3
       RETURNING *`,
      ["failed", "prompt_id_missing", runId]
    );
    return { ok: false, error: { status: 502, message: "prompt_id_missing", details: { runId } } };
  }

  const updated = await pool.query(
    `UPDATE comfy_runs
     SET status = $1, prompt_id = $2, updated_at = NOW(), started_at = NOW()
     WHERE id = $3
     RETURNING *`,
    ["queued", promptId, runId]
  );

  return { ok: true, run: updated.rows[0] };
};

const resolveQueueStatus = (queueData: unknown, promptId: string): "queued" | "running" | null => {
  if (!queueData || typeof queueData !== "object") return null;
  const record = queueData as Record<string, unknown>;
  const hasPrompt = (value: unknown) => {
    if (!Array.isArray(value)) return false;
    return value.some((item) => {
      if (Array.isArray(item)) return item[0] === promptId;
      if (item && typeof item === "object" && (item as any).prompt_id === promptId) return true;
      return item === promptId;
    });
  };
  if (hasPrompt(record.queue_running)) return "running";
  if (hasPrompt(record.queue_pending)) return "queued";
  return null;
};

const resolveHistoryEntry = (historyData: unknown, promptId: string) => {
  if (!historyData || typeof historyData !== "object") return null;
  const record = historyData as Record<string, unknown>;
  const entry = record[promptId];
  if (entry && typeof entry === "object") return entry as Record<string, unknown>;
  if ((record as any).prompt_id === promptId || (record as any).promptId === promptId) {
    return record as Record<string, unknown>;
  }
  return null;
};

const resolveWorkflowOutputNodeInfo = (
  workflow: unknown
): {
  outputNodeIds: Set<string>;
  preprocessorOutputNodeIds: Set<string>;
  preprocessorPreviewNodeIds: Set<string>;
} | null => {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) return null;
  const record = workflow as Record<string, unknown>;
  const outputIds = new Set<string>();
  const preprocessorOutputIds = new Set<string>();
  const preprocessorPreviewIds = new Set<string>();
  const preprocessorClassPattern = /preprocessor/i;
  const samplerClassPattern = /ksampler/i;
  const previewClassPattern = /previewimage/i;
  const nodes = record as Record<string, any>;

  const getInputNodeIds = (node: any) => {
    if (!node || typeof node !== "object") return [] as string[];
    const inputs = node.inputs;
    if (!inputs || typeof inputs !== "object") return [] as string[];
    const ids: string[] = [];
    for (const value of Object.values(inputs)) {
      if (Array.isArray(value) && typeof value[0] === "string") {
        ids.push(value[0]);
      }
    }
    return ids;
  };

  const analyzeUpstream = (startId: string) => {
    const visited = new Set<string>();
    const stack = [startId];
    let hasPreprocessor = false;
    let hasSampler = false;
    while (stack.length > 0) {
      const currentId = stack.pop()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      const node = nodes[currentId];
      if (!node || typeof node !== "object") continue;
      const classType = node.class_type;
      if (typeof classType === "string") {
        if (preprocessorClassPattern.test(classType)) {
          hasPreprocessor = true;
        }
        if (samplerClassPattern.test(classType)) {
          hasSampler = true;
        }
      }
      const nextIds = getInputNodeIds(node);
      for (const nextId of nextIds) {
        if (!visited.has(nextId)) {
          stack.push(nextId);
        }
      }
    }
    return { hasPreprocessor, hasSampler };
  };

  for (const [nodeId, node] of Object.entries(record)) {
    if (!node || typeof node !== "object") continue;
    const classType = (node as any).class_type;
    if (typeof classType !== "string") continue;
    if (/saveimage/i.test(classType)) {
      outputIds.add(nodeId);
      const analysis = analyzeUpstream(nodeId);
      if (analysis.hasPreprocessor && !analysis.hasSampler) {
        preprocessorOutputIds.add(nodeId);
      }
    }
    if (previewClassPattern.test(classType)) {
      const analysis = analyzeUpstream(nodeId);
      if (analysis.hasPreprocessor && !analysis.hasSampler) {
        preprocessorPreviewIds.add(nodeId);
      }
    }
  }
  return outputIds.size > 0
    ? {
        outputNodeIds: outputIds,
        preprocessorOutputNodeIds: preprocessorOutputIds,
        preprocessorPreviewNodeIds: preprocessorPreviewIds
      }
    : null;
};

const extractHistoryOutputs = (
  historyEntry: Record<string, unknown> | null,
  outputNodeIds?: Set<string> | null,
  excludeNodeIds?: Set<string> | null,
  includeNonOutputNodeIds?: Set<string> | null
): ComfyOutputImage[] => {
  if (!historyEntry) return [];
  const outputs = (historyEntry.outputs ?? historyEntry.output ?? historyEntry.result) as unknown;
  if (!outputs) return [];
  const images: ComfyOutputImage[] = [];
  const visited = new Set<object>();

  const walk = (value: unknown, nodeId?: string | null) => {
    if (!value || typeof value !== "object") return;
    if (visited.has(value as object)) return;
    visited.add(value as object);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, nodeId);
      return;
    }

    const record = value as Record<string, unknown>;
    if (typeof record.filename === "string") {
      if (excludeNodeIds && nodeId && excludeNodeIds.has(nodeId)) {
        return;
      }
      if (
        outputNodeIds &&
        nodeId &&
        !outputNodeIds.has(nodeId) &&
        !(includeNonOutputNodeIds && includeNonOutputNodeIds.has(nodeId))
      ) {
        return;
      }
      const subfolder = typeof record.subfolder === "string" ? record.subfolder : null;
      const typeRaw = typeof record.type === "string" ? record.type : null;
      const typeNormalized =
        typeRaw || (subfolder && subfolder.toLowerCase() === "output" ? "output" : null);
      images.push({
        filename: record.filename,
        subfolder,
        type: typeNormalized,
        nodeId: nodeId ?? null
      });
    }

    for (const item of Object.values(record)) {
      walk(item, nodeId);
    }
  };

  if (outputs && typeof outputs === "object" && !Array.isArray(outputs)) {
    for (const [nodeId, value] of Object.entries(outputs as Record<string, unknown>)) {
      walk(value, nodeId);
    }
  } else {
    walk(outputs, null);
  }

  const isOutputImage = (image: ComfyOutputImage) => {
    const type = (image.type || "").toLowerCase();
    const subfolder = (image.subfolder || "").toLowerCase();
    return type === "output" || subfolder === "output";
  };
  const outputImages = images.filter(isOutputImage);
  const baseImages = outputImages.length > 0 ? outputImages : images;
  const extraImages =
    includeNonOutputNodeIds && includeNonOutputNodeIds.size > 0
      ? images.filter((image) => image.nodeId && includeNonOutputNodeIds.has(image.nodeId))
      : [];
  const selectedImages = extraImages.length > 0 ? [...baseImages, ...extraImages] : baseImages;

  const grouped = new Map<string, ComfyOutputImage[]>();
  for (const image of selectedImages) {
    const key = image.filename;
    const group = grouped.get(key);
    if (group) {
      group.push(image);
    } else {
      grouped.set(key, [image]);
    }
  }

  const selected: ComfyOutputImage[] = [];
  for (const group of grouped.values()) {
    const output = group.find((item) => (item.type || "").toLowerCase() === "output");
    selected.push(output ?? group[0]);
  }

  return selected;
};

const resolveHistoryStatus = (historyEntry: Record<string, unknown> | null, outputs: ComfyOutputImage[]) => {
  if (!historyEntry) return null;
  const statusValue = (historyEntry.status ?? historyEntry.status_str) as unknown;
  const statusText =
    typeof statusValue === "string"
      ? statusValue
      : typeof (statusValue as any)?.status_str === "string"
        ? (statusValue as any).status_str
        : "";
  const normalized = statusText.toLowerCase();
  if (normalized.includes("error") || normalized.includes("fail")) return "failed";
  if (normalized.includes("success") || normalized.includes("complete")) return "succeeded";
  if (historyEntry.error || historyEntry.errors) return "failed";
  if (outputs.length > 0) return "succeeded";
  return null;
};

const extractTagString = (value: unknown) => {
  const preferred: string[] = [];
  const fallback: string[] = [];
  const visited = new Set<object>();
  const keyHint = /tags|tag|caption|text/i;

  const scoreText = (text: string) => {
    const commaCount = (text.match(/,/g) || []).length;
    return commaCount * 10 + text.length;
  };

  const addCandidate = (text: string, isPreferred: boolean) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (isPreferred) {
      preferred.push(trimmed);
      return;
    }
    const commaCount = (trimmed.match(/,/g) || []).length;
    if (commaCount < 2 || trimmed.length < 20) return;
    fallback.push(trimmed);
  };

  const walk = (input: unknown, isPreferred = false) => {
    if (input === null || input === undefined) return;
    if (typeof input === "string") {
      addCandidate(input, isPreferred);
      return;
    }
    if (typeof input !== "object") return;
    if (visited.has(input as object)) return;
    visited.add(input as object);
    if (Array.isArray(input)) {
      for (const item of input) walk(item, isPreferred);
      return;
    }
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      const nextPreferred = isPreferred || keyHint.test(key);
      walk(val, nextPreferred);
    }
  };

  walk(value);

  const pickBest = (candidates: string[]) => {
    let best = "";
    let bestScore = -1;
    for (const candidate of candidates) {
      const score = scoreText(candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  };

  if (preferred.length > 0) return pickBest(preferred);
  if (fallback.length > 0) return pickBest(fallback);
  return "";
};

const TARGET_VALUES = ["SDXL", "COMFYUI_BLOCKS"] as const;
const targetSchema = z.enum(TARGET_VALUES);

const promptBlocksSchema = z
  .object({
    positive: z.string().optional(),
    negative: z.string().optional(),
    notes: z.string().optional()
  })
  .catchall(z.any())
  .refine((value) => value && typeof value === "object" && !Array.isArray(value), {
    message: "promptBlocks must be an object"
  });

const jsonObjectSchema = z.object({}).passthrough();

const normalizeStringArray = (value?: unknown) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
};

const normalizeOptionalFileName = (value?: string | null) => {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const loraCreateSchema = z.object({
  name: z.string().trim().min(1),
  fileName: z.string().trim().nullable().optional(),
  triggerWords: z.array(z.string().trim()).optional(),
  recommendedWeightMin: z.number().finite().nullable().optional(),
  recommendedWeightMax: z.number().finite().nullable().optional(),
  notes: z.string().nullable().optional(),
  tags: z.array(z.string().trim()).optional(),
  examplePrompts: z.array(z.string().trim()).optional()
});

const loraUpdateSchema = loraCreateSchema.partial().refine(
  (data) =>
    data.name !== undefined ||
    data.fileName !== undefined ||
    data.triggerWords !== undefined ||
    data.recommendedWeightMin !== undefined ||
    data.recommendedWeightMax !== undefined ||
    data.notes !== undefined ||
    data.tags !== undefined ||
    data.examplePrompts !== undefined,
  {
    message: "Nothing to update"
  }
);

const recipeCreateSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    target: targetSchema,
    promptBlocks: promptBlocksSchema.optional(),
    variables: jsonObjectSchema.optional(),
    tags: z.array(z.string().trim()).optional(),
    pinned: z.boolean().optional(),
    sourceIdeaId: z.string().uuid().optional()
  })
  .superRefine((value, ctx) => {
    const hasPrompt = value.promptBlocks !== undefined;
    const hasSource = value.sourceIdeaId !== undefined;
    if (!hasPrompt && !hasSource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "promptBlocks or sourceIdeaId is required"
      });
    }
    if (hasPrompt && hasSource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose either promptBlocks or sourceIdeaId"
      });
    }
  });

const recipeUpdateSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    target: targetSchema.optional(),
    promptBlocks: promptBlocksSchema.optional(),
    variables: jsonObjectSchema.optional(),
    tags: z.array(z.string().trim()).optional(),
    pinned: z.boolean().optional(),
    sourceIdeaId: z.string().uuid().nullable().optional()
  })
  .refine(
    (data) =>
      data.title !== undefined ||
      data.target !== undefined ||
      data.promptBlocks !== undefined ||
      data.variables !== undefined ||
      data.tags !== undefined ||
      data.pinned !== undefined ||
      data.sourceIdeaId !== undefined,
    { message: "Nothing to update" }
  );

const recipeLoraUpsertSchema = z.object({
  loraId: z.string().uuid(),
  weight: z.number().finite().nullable().optional(),
  usageNotes: z.string().nullable().optional(),
  sortOrder: z.number().int().optional()
});

const WHISPER_LANGUAGE_ENUM = z.enum(WHISPER_LANGUAGES);

const whisperJobCreateSchema = z.object({
  modelFile: z.string().trim().min(1),
  language: WHISPER_LANGUAGE_ENUM.optional()
});

const comfyLoraInputSchema = z.object({
  name: z.string().trim().min(1),
  weight: z.number().finite().optional().default(1),
  enabled: z.boolean().optional().default(true)
});

const comfyKSamplerSchema = z
  .object({
    steps: z.number().int().min(1).max(200).optional(),
    cfg: z.number().finite().optional(),
    sampler: z.string().trim().min(1).optional(),
    sampler_name: z.string().trim().min(1).optional(),
    scheduler: z.string().trim().min(1).optional(),
    seed: z.number().int().optional(),
    denoise: z.number().finite().min(0).max(1).optional()
  })
  .partial();

const comfyRunCreateSchema = z
  .object({
    workflowId: z.string().trim().min(1),
    positive: z.string(),
    negative: z.string(),
    ckptName: z.string().trim().min(1),
    width: z.number().int().min(64).max(8192).finite(),
    height: z.number().int().min(64).max(8192).finite(),
    loras: z.array(comfyLoraInputSchema).optional().default([]),
    controlnetEnabled: z.boolean(),
    controlnetModel: z.string().trim().optional(),
    preprocessorEnabled: z.boolean(),
    preprocessor: z.string().trim().optional(),
    controlnetStrength: z.number().finite().min(0).max(2).optional(),
    ksampler: comfyKSamplerSchema.optional()
  })
  .superRefine((value, ctx) => {
    if (!["base_text2i", "base_image2i"].includes(value.workflowId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "workflowId must be base_text2i or base_image2i"
      });
    }
    if (value.controlnetEnabled && !value.controlnetModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "controlnetModel is required"
      });
    }
    if (value.preprocessorEnabled && !value.preprocessor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "preprocessor is required"
      });
    }
  });

type ComfyRunCreateInput = z.infer<typeof comfyRunCreateSchema>;

const ideasZodSchema = (count: number) =>
  z.object({
    ideas: z
      .array(
        z.object({
          title: z.string(),
          description: z.string(),
          prompt_snippet: z.string(),
          tags: z.array(z.string())
        })
      )
      .min(count)
      .max(count)
  });

const buildIdeasJsonSchema = (count: number) => ({
  type: "object",
  properties: {
    ideas: {
      type: "array",
      minItems: count,
      maxItems: count,
      items: {
        type: "object",
        required: ["title", "description", "prompt_snippet", "tags"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          prompt_snippet: { type: "string" },
          tags: { type: "array", items: { type: "string" } }
        }
      }
    }
  },
  required: ["ideas"]
});

const buildOllamaOptions = () => {
  const options: Record<string, unknown> = { temperature: OLLAMA_TEMPERATURE };
  if (OLLAMA_NUM_GPU !== undefined) options.num_gpu = OLLAMA_NUM_GPU;
  return options;
};

const translateTagsRequestSchema = z.object({
  tags: z.array(z.string()),
  force: z.boolean().optional()
});

const translateTagsFormat = {
  type: "object",
  properties: {
    translations: {
      type: "object",
      additionalProperties: { type: "string" }
    }
  },
  required: ["translations"]
};

const buildTranslateMessages = (tags: string[]) => [
  {
    role: "system",
    content:
      "You translate short Stable Diffusion tags into concise Japanese. Output JSON only. No prose, no markdown, no code fences."
  },
  {
    role: "user",
    content: [
      "Translate the following tags into concise Japanese.",
      "Rules:",
      "- Keep technical terms and proper nouns when appropriate.",
      "- Never return empty strings; if unsure, return the original tag.",
      "Output JSON only in the form: {\"translations\": {\"tag\": \"translation\"}}",
      `Tags: ${JSON.stringify(tags)}`
    ].join("\n")
  }
];

const parseTranslateResponse = (content: string) => {
  const parsed = extractJsonPayload(content);
  if (!parsed || typeof parsed !== "object") return null;
  const translationsRaw = (parsed as Record<string, unknown>).translations;
  if (!translationsRaw || typeof translationsRaw !== "object") return null;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(translationsRaw)) {
    if (typeof value === "string" && value.trim().length > 0) {
      normalized[key] = value.trim();
    }
  }
  return normalized;
};

const logEvent = async (db: Queryable, sessionId: string, eventType: string, payload: unknown) => {
  await db.query("INSERT INTO session_events (session_id, event_type, payload) VALUES ($1, $2, $3)", [
    sessionId,
    eventType,
    payload
  ]);
};

const safeLogError = async (sessionId: string, message: string, details?: unknown) => {
  try {
    await logEvent(pool, sessionId, "ERROR", { message, details });
  } catch (err) {
    console.error("Failed to log error event", err);
  }
};

app.get(
  "/api/health",
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: { status: "ok" } });
  })
);

app.get(
  "/api/comfy/status",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "no-store");
    const status = await comfyService.getStatus();
    res.json({ ok: true, data: { status } });
  })
);

app.post(
  "/api/comfy/start",
  asyncHandler(async (_req, res) => {
    const result = await comfyService.start();
    if (result.error) {
      return respondError(res, 400, result.error);
    }
    res.json({ ok: true, data: result });
  })
);

app.post(
  "/api/comfy/stop",
  asyncHandler(async (_req, res) => {
    const result = await comfyService.stop();
    if (!result.stopped) {
      return respondError(res, 400, result.error || "ComfyUI stop is allowed only for API-managed process");
    }
    res.json({ ok: true, data: result });
  })
);

  app.get(
    "/api/comfy/object-info/:nodeClass",
    asyncHandler(async (req, res) => {
      res.set("Cache-Control", "no-store");
    const rawNodeClass = typeof req.params.nodeClass === "string" ? req.params.nodeClass : "";
    const nodeClass = safeDecodeURIComponent(rawNodeClass);
    if (!nodeClass.trim()) {
      return respondError(res, 400, "nodeClass is required");
    }

    const result = await fetchComfyObjectInfo(nodeClass);
    if (!result.ok) {
      const status = result.error.message === "timeout" ? 504 : 502;
      return respondError(res, status, result.error.message, {
        nodeClass: result.nodeClass,
        ...(result.error.details ?? {})
      });
    }

      res.json({ ok: true, data: { nodeClass: result.nodeClass, objectInfo: result.objectInfo } });
    })
  );

  app.get(
    "/api/comfy/queue",
    asyncHandler(async (_req, res) => {
      res.set("Cache-Control", "no-store");
      const result = await fetchComfyJson("/queue", { method: "GET" }, COMFY_REQUEST_TIMEOUT_MS);
      if (!result.ok) {
        const status = result.error.message === "timeout" ? 504 : 502;
        return respondError(res, status, result.error.message, {
          ...(result.error.details ? { details: result.error.details } : {})
        });
      }
      res.json({ ok: true, data: result.data });
    })
  );

app.get(
  "/api/comfy/runner/text2i/options",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "no-store");

    const targets = [
      {
        key: "ckptNames",
        nodeClass: "Efficient Loader",
        extractor: (info: unknown) =>
          collectChoicesByKey(info, (key) => /ckpt|checkpoint/i.test(key))
      },
      {
        key: "loraNames",
        nodeClass: "LoRA Stacker",
        extractor: (info: unknown) =>
          collectChoicesByKey(info, (key) => /lora.*name/i.test(key))
      },
      {
        key: "controlnetModelNames",
        nodeClass: "ControlNetLoader",
        extractor: (info: unknown) =>
          collectChoicesByKey(info, (key) => /control[_-]?net.*(name|model)|controlnet/i.test(key))
      },
      {
        key: "preprocessorNames",
        nodeClass: "ControlNetPreprocessorSelector",
        extractor: (info: unknown) =>
          collectChoicesByKey(info, (key) => /preprocessor|preprocess|processor/i.test(key))
      }
    ] as const;

    const results = await Promise.all(
      targets.map(async (target) => {
        const result = await fetchComfyObjectInfo(target.nodeClass, true);
        if (!result.ok) {
          return { ok: false as const, nodeClass: target.nodeClass, key: target.key, error: result.error };
        }
        return {
          ok: true as const,
          nodeClass: target.nodeClass,
          key: target.key,
          values: target.extractor(result.objectInfo)
        };
      })
    );

    const data: Record<string, unknown> = {
      ckptNames: [],
      loraNames: [],
      controlnetModelNames: [],
      preprocessorNames: [],
      partialErrors: [] as ComfyPartialError[],
      defaults: null as ComfyTemplateDefaults | null,
      image2iDefaults: null as ComfyImage2iDefaults | null
    };

    let successCount = 0;
    const partialErrors: ComfyPartialError[] = [];

    for (const result of results) {
      if (result.ok) {
        successCount += 1;
        data[result.key] = result.values;
        continue;
      }
      partialErrors.push({
        nodeClass: result.nodeClass,
        message: result.error.message,
        ...(result.error.details ? { details: result.error.details } : {})
      });
    }

    data.partialErrors = partialErrors;
    try {
      data.defaults = await getComfyTemplateDefaults();
    } catch (err) {
      console.error("Failed to load Comfy template defaults", err);
    }
    try {
      data.image2iDefaults = await getComfyImage2iDefaults();
    } catch (err) {
      console.error("Failed to load Comfy image2i defaults", err);
    }

    if (successCount === 0) {
      return respondError(res, 502, "options_unavailable", { partialErrors });
    }

    res.json({ ok: true, data });
  })
);

app.get(
  "/api/comfy/view",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const allowedKeys = new Set(["filename", "subfolder", "type"]);
    for (const key of Object.keys(req.query)) {
      if (!allowedKeys.has(key)) {
        return respondError(res, 400, "Invalid query parameter", { key });
      }
    }

    const filenameRaw = req.query.filename;
    const subfolderRaw = req.query.subfolder;
    const typeRaw = req.query.type;
    if (Array.isArray(filenameRaw) || Array.isArray(subfolderRaw) || Array.isArray(typeRaw)) {
      return respondError(res, 400, "Invalid query parameter");
    }

    const filename = typeof filenameRaw === "string" ? filenameRaw.trim() : "";
    if (!filename) {
      return respondError(res, 400, "filename is required");
    }
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\") || filename !== path.basename(filename)) {
      return respondError(res, 400, "Invalid filename");
    }

    const query = new URLSearchParams({ filename });
    if (typeof subfolderRaw === "string" && subfolderRaw.trim()) {
      query.set("subfolder", subfolderRaw.trim());
    }
    if (typeof typeRaw === "string" && typeRaw.trim()) {
      query.set("type", typeRaw.trim());
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), COMFY_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${COMFY_BASE_URL}/view?${query.toString()}`, { signal: controller.signal });
      if (!response.ok) {
        const text = await response.text();
        return respondError(res, 502, "upstream_error", { status: response.status, body: truncateText(text) });
      }

      const contentType = response.headers.get("content-type");
      if (contentType) {
        res.setHeader("Content-Type", contentType);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "AbortError";
      return respondError(res, isTimeout ? 504 : 502, isTimeout ? "timeout" : "comfy_unreachable", {
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      clearTimeout(timeoutId);
    }
  })
);

app.post(
  "/api/comfy/tagger",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      await runComfyTaggerUpload(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid upload";
      return respondError(res, 400, "Invalid upload", { message });
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      return respondError(res, 400, "image is required");
    }

    const safeExt = resolveImageExtension(file);
    const inputFile = `tagger_${randomUUID()}_${Date.now()}${safeExt}`;
    const inputName = await writeComfyInputFile("tagger_inputs", inputFile, file.buffer);

    let workflow: Record<string, any>;
    try {
      workflow = await readWorkflowTemplate(COMFY_WORKFLOW_TAGGER_PATH);
      const loadImageInputs = getNodeInputs(workflow, "1", "LoadImage (tagger)");
      loadImageInputs.image = inputName;
    } catch (err) {
      return respondError(res, 500, "Failed to prepare tagger workflow", {
        error: err instanceof Error ? err.message : String(err)
      });
    }

    const promptResult = await fetchComfyJson(
      "/prompt",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow })
      },
      COMFY_REQUEST_TIMEOUT_MS
    );

    if (!promptResult.ok) {
      const errorMessage = promptResult.error.message;
      return respondError(res, errorMessage === "timeout" ? 504 : 502, errorMessage, {
        ...(promptResult.error.details ? { details: promptResult.error.details } : {})
      });
    }

    if (promptResult.data && typeof promptResult.data === "object" && (promptResult.data as any).error) {
      const errorValue = (promptResult.data as any).error;
      const errorMessage =
        errorValue && typeof errorValue === "object" && typeof errorValue.message === "string"
          ? errorValue.message
          : typeof errorValue === "string"
            ? errorValue
            : "prompt_error";
      return respondError(res, 502, errorMessage);
    }

    const promptId =
      promptResult.data && typeof promptResult.data === "object" && (promptResult.data as any).prompt_id
        ? String((promptResult.data as any).prompt_id)
        : "";

    if (!promptId) {
      return respondError(res, 502, "prompt_id_missing");
    }

    const pollStart = Date.now();
    let lastRaw = "";
    while (Date.now() - pollStart < COMFY_TAGGER_POLL_TIMEOUT_MS) {
      const historyResult = await fetchComfyJson(
        `/history/${encodeURIComponent(promptId)}`,
        { method: "GET" },
        COMFY_REQUEST_TIMEOUT_MS
      );

      if (!historyResult.ok) {
        const errorMessage = historyResult.error.message;
        return respondError(res, errorMessage === "timeout" ? 504 : 502, errorMessage, {
          ...(historyResult.error.details ? { details: historyResult.error.details } : {})
        });
      }

      lastRaw = truncateText(JSON.stringify(historyResult.data ?? ""), 2000);
      const historyEntry = resolveHistoryEntry(historyResult.data, promptId);
      const historyError = historyEntry ? (historyEntry as any).error ?? (historyEntry as any).errors : null;
      if (historyError) {
        const message =
          typeof historyError === "string"
            ? historyError
            : Array.isArray(historyError)
              ? historyError.join("; ")
              : JSON.stringify(historyError);
        return respondError(res, 502, "comfy_failed", { message, raw: lastRaw });
      }

      const statusValue = historyEntry ? ((historyEntry as any).status ?? (historyEntry as any).status_str) : undefined;
      const statusText =
        typeof statusValue === "string"
          ? statusValue
          : typeof (statusValue as any)?.status_str === "string"
            ? (statusValue as any).status_str
            : "";
      const normalizedStatus = statusText.toLowerCase();
      if (normalizedStatus.includes("error") || normalizedStatus.includes("fail")) {
        return respondError(res, 502, "comfy_failed", { raw: lastRaw });
      }

      const outputsSource = historyEntry?.outputs ?? historyEntry?.output ?? historyEntry?.result ?? null;
      const tags = extractTagString(outputsSource ?? historyEntry ?? historyResult.data);
      if (tags) {
        return res.json({ ok: true, data: { tags } });
      }
      if (normalizedStatus.includes("success") || normalizedStatus.includes("complete")) {
        return respondError(res, 502, "tags_not_found", { raw: lastRaw });
      }

      await new Promise((resolve) => setTimeout(resolve, COMFY_TAGGER_POLL_INTERVAL_MS));
    }

    return respondError(res, 504, "timeout", { promptId, raw: lastRaw });
  })
);

app.post(
  "/api/comfy/runs",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      await runComfyRunUpload(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid upload";
      return respondError(res, 400, "Invalid upload", { message });
    }

    const body = req.body as Record<string, unknown>;
    const lorasPayload = parseJsonPayload(body.loras);
    if (!lorasPayload.ok) {
      return respondError(res, 400, "Invalid loras JSON", { error: lorasPayload.error });
    }
    const ksamplerPayload = parseJsonPayload(body.ksampler);
    if (!ksamplerPayload.ok) {
      return respondError(res, 400, "Invalid ksampler JSON", { error: ksamplerPayload.error });
    }

    const files = (req as any).files as Record<string, Express.Multer.File[]> | undefined;
    const initImageFile = files?.initImage?.[0];
    const controlnetFile = files?.controlnetImage?.[0];
    const useImage2i = Boolean(initImageFile);
    const workflowId = useImage2i ? "base_image2i" : "base_text2i";
    const width = Number(body.width);
    const height = Number(body.height);
    const controlnetStrength = body.controlnetStrength !== undefined ? Number(body.controlnetStrength) : undefined;

    const parsed = comfyRunCreateSchema.safeParse({
      workflowId,
      positive: typeof body.positive === "string" ? body.positive : "",
      negative: typeof body.negative === "string" ? body.negative : "",
      ckptName: typeof body.ckptName === "string" ? body.ckptName.trim() : "",
      width,
      height,
      loras: lorasPayload.value ?? [],
      controlnetEnabled: parseBoolean(body.controlnetEnabled, false),
      controlnetModel: typeof body.controlnetModel === "string" ? body.controlnetModel.trim() : undefined,
      preprocessorEnabled: parseBoolean(body.preprocessorEnabled, false),
      preprocessor: typeof body.preprocessor === "string" ? body.preprocessor.trim() : undefined,
      controlnetStrength: Number.isFinite(controlnetStrength) ? controlnetStrength : undefined,
      ksampler: ksamplerPayload.value ?? undefined
    });

    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const created = await createComfyRun(parsed.data, { initImageFile, controlnetFile });
    if (!created.ok) {
      return respondError(res, created.error.status, created.error.message, created.error.details);
    }

    res.status(201).json({ ok: true, data: { run: created.run } });
  })
);

app.get(
  "/api/comfy/runs",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const parsed = comfyRunsListSchema.safeParse(req.query);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const recipeId = parsed.data.recipeId;
    const result = recipeId
      ? await pool.query("SELECT * FROM comfy_runs WHERE recipe_id = $1 ORDER BY updated_at DESC", [recipeId])
      : await pool.query("SELECT * FROM comfy_runs ORDER BY updated_at DESC");
    res.json({ ok: true, data: { runs: result.rows } });
  })
);

app.get(
  "/api/comfy/runs/:id",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const runId = z.string().uuid().safeParse(req.params.id);
    if (!runId.success) {
      return respondError(res, 400, "Invalid run id");
    }
    const result = await pool.query("SELECT * FROM comfy_runs WHERE id = $1", [runId.data]);
    if (result.rowCount === 0) {
      return respondError(res, 404, "Run not found");
    }
    res.json({ ok: true, data: { run: result.rows[0] } });
  })
);

app.delete(
  "/api/comfy/runs/:id",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const runId = z.string().uuid().safeParse(req.params.id);
    if (!runId.success) {
      return respondError(res, 400, "Invalid run id");
    }
    const result = await pool.query("DELETE FROM comfy_runs WHERE id = $1 RETURNING *", [runId.data]);
    if (result.rowCount === 0) {
      return respondError(res, 404, "Run not found");
    }
    res.json({ ok: true, data: { id: runId.data } });
  })
);

app.post(
  "/api/comfy/runs/:id/refresh",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const runId = z.string().uuid().safeParse(req.params.id);
    if (!runId.success) {
      return respondError(res, 400, "Invalid run id");
    }

    const runResult = await pool.query("SELECT * FROM comfy_runs WHERE id = $1", [runId.data]);
    if (runResult.rowCount === 0) {
      return respondError(res, 404, "Run not found");
    }

    const run = runResult.rows[0];
    if (!run.prompt_id) {
      return respondError(res, 400, "prompt_id is required");
    }

    const queueResult = await fetchComfyJson("/queue", { method: "GET" }, COMFY_REQUEST_TIMEOUT_MS);
    if (!queueResult.ok) {
      const errorMessage = queueResult.error.message;
      await pool.query(
        `UPDATE comfy_runs
         SET status = $1, error_message = $2, updated_at = NOW(), finished_at = NOW()
         WHERE id = $3`,
        ["failed", errorMessage, runId.data]
      );
      const status = errorMessage === "timeout" ? 504 : 502;
      return respondError(res, status, errorMessage, {
        runId: runId.data,
        ...(queueResult.error.details ? { details: queueResult.error.details } : {})
      });
    }

    const queueStatus = resolveQueueStatus(queueResult.data, run.prompt_id);

    const historyResult = await fetchComfyJson(
      `/history/${encodeURIComponent(run.prompt_id)}`,
      { method: "GET" },
      COMFY_REQUEST_TIMEOUT_MS
    );

    if (!historyResult.ok) {
      const errorMessage = historyResult.error.message;
      await pool.query(
        `UPDATE comfy_runs
         SET status = $1, error_message = $2, updated_at = NOW(), finished_at = NOW()
         WHERE id = $3`,
        ["failed", errorMessage, runId.data]
      );
      const status = errorMessage === "timeout" ? 504 : 502;
      return respondError(res, status, errorMessage, {
        runId: runId.data,
        ...(historyResult.error.details ? { details: historyResult.error.details } : {})
      });
    }

      const historyEntry = resolveHistoryEntry(historyResult.data, run.prompt_id);
      const outputNodeInfo = resolveWorkflowOutputNodeInfo(run.workflow_json);
      const controlnetEnabled =
        run.request_json && typeof run.request_json === "object"
          ? Boolean((run.request_json as any).controlnetEnabled)
          : false;
      const preprocessorOutputNodeIds = outputNodeInfo?.preprocessorOutputNodeIds ?? null;
      const preprocessorPreviewNodeIds = outputNodeInfo?.preprocessorPreviewNodeIds ?? null;
      const excludeNodeIds =
        !controlnetEnabled && (preprocessorOutputNodeIds || preprocessorPreviewNodeIds)
          ? new Set([
              ...(preprocessorOutputNodeIds ? Array.from(preprocessorOutputNodeIds) : []),
              ...(preprocessorPreviewNodeIds ? Array.from(preprocessorPreviewNodeIds) : [])
            ])
          : null;
      const includeNonOutputNodeIds = controlnetEnabled ? preprocessorPreviewNodeIds : null;
      const outputs = extractHistoryOutputs(
        historyEntry,
        outputNodeInfo?.outputNodeIds ?? null,
        excludeNodeIds,
        includeNonOutputNodeIds
      );
      const historyStatus = resolveHistoryStatus(historyEntry, outputs);
      const startedAtValue = run.started_at ?? run.created_at;
      const startedAtMs =
        typeof startedAtValue === "string" || startedAtValue instanceof Date
          ? new Date(startedAtValue).getTime()
          : Number.isFinite(Number(startedAtValue))
            ? Number(startedAtValue)
            : NaN;
      const withinGrace = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs <= COMFY_HISTORY_GRACE_MS : true;
      const priorStatus = typeof run.status === "string" ? run.status : null;

      let nextStatus: ComfyRunStatus | null = null;
      let errorMessage: string | null | undefined;
      let historyJson: Record<string, unknown> | null | undefined;

      if (historyEntry) {
        historyJson = { outputs };
        if (historyStatus === "failed") {
          const historyError = (historyEntry as any).error ?? (historyEntry as any).errors;
          const historyErrorMessage =
          typeof historyError === "string"
            ? historyError
            : Array.isArray(historyError)
              ? historyError.join("; ")
              : historyError
                ? JSON.stringify(historyError)
                : null;
          nextStatus = "failed";
          errorMessage = historyErrorMessage ?? "comfy_failed";
        } else if (historyStatus === "succeeded") {
          nextStatus = "succeeded";
          errorMessage = null;
        }
      }

      if (!nextStatus) {
        if (queueStatus === "running") {
          nextStatus = "running";
          errorMessage = null;
        } else if (queueStatus === "queued") {
          nextStatus = "queued";
          errorMessage = null;
        }
      }

      if (!nextStatus) {
        const historyEmpty = !historyEntry || outputs.length === 0;
        if (historyEmpty) {
          const retryHistoryEmpty = priorStatus === "failed" && run.error_message === "history_empty";
          if (withinGrace) {
            if (retryHistoryEmpty) {
              nextStatus = "queued";
              errorMessage = null;
            } else if (priorStatus === "created" || priorStatus === "queued" || priorStatus === "running") {
              nextStatus = priorStatus as ComfyRunStatus;
            } else if (
              priorStatus === "succeeded" ||
              priorStatus === "failed" ||
              priorStatus === "blocked" ||
              priorStatus === "stale"
            ) {
              nextStatus = priorStatus as ComfyRunStatus;
            } else {
              nextStatus = "queued";
            }
          } else {
            nextStatus = "stale";
            errorMessage = "history_missing";
          }
        }
      }

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (nextStatus) {
      updates.push(`status = $${idx++}`);
      values.push(nextStatus);
      if (nextStatus === "running") {
        updates.push("started_at = COALESCE(started_at, NOW())");
      }
      if (nextStatus === "succeeded" || nextStatus === "failed" || nextStatus === "blocked") {
        updates.push("finished_at = NOW()");
      }
    }

    if (historyJson !== undefined) {
      updates.push(`history_json = $${idx++}`);
      values.push(historyJson);
    }

    if (errorMessage !== undefined) {
      updates.push(`error_message = $${idx++}`);
      values.push(errorMessage);
    }

    updates.push("updated_at = NOW()");
    values.push(runId.data);

    const updated = await pool.query(
      `UPDATE comfy_runs SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );

    const updatedRun = updated.rows[0];

    if (nextStatus === "succeeded" && outputs.length > 0) {
      try {
        const items = buildGalleryItemsFromRun(updatedRun, outputs);
        await upsertGalleryItems(pool, items);
      } catch (err) {
        console.error("Gallery sync failed", { runId: runId.data, error: err });
      }
    }

    res.json({ ok: true, data: { run: updatedRun } });
  })
);

app.get(
  "/api/gallery/items",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const parsed = galleryListSchema.safeParse(req.query);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const limit = parsed.data.limit ?? 60;
    const cursorRaw = parsed.data.cursor;
    const cursor = cursorRaw ? parseGalleryCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) {
      return respondError(res, 400, "Invalid cursor");
    }

    const favorited = parseOptionalBoolean(parsed.data.favorited);
    if (favorited === null) {
      return respondError(res, 400, "Invalid favorited filter");
    }

    const filters: GalleryFilters = {};
    if (parsed.data.ckpt) filters.ckpt = parsed.data.ckpt.trim();
    const loras = normalizeStringList(parsed.data.lora);
    if (loras.length > 0) filters.loras = loras;
    if (typeof parsed.data.w === "number") filters.width = parsed.data.w;
    if (typeof parsed.data.h === "number") filters.height = parsed.data.h;
    if (parsed.data.q) filters.q = parsed.data.q.trim();
    if (typeof favorited === "boolean") filters.favorited = favorited;

    if (parsed.data.dateFrom) {
      const dateFrom = parseDateParam(parsed.data.dateFrom);
      if (!dateFrom) {
        return respondError(res, 400, "Invalid dateFrom");
      }
      filters.dateFrom = dateFrom;
    }
    if (parsed.data.dateTo) {
      const dateTo = parseDateParam(parsed.data.dateTo);
      if (!dateTo) {
        return respondError(res, 400, "Invalid dateTo");
      }
      filters.dateTo = dateTo;
    }

    const result = await listGalleryItems(pool, { limit, cursor, filters });
    const items = result.items.map((item) => {
      const mapped = mapGalleryItem(item);
      return {
        ...mapped,
        viewUrl: buildComfyViewUrl(mapped)
      };
    });

    res.json({ ok: true, data: { items, nextCursor: result.nextCursor } });
  })
);

app.get(
  "/api/gallery/items/:id",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const itemId = z.string().uuid().safeParse(req.params.id);
    if (!itemId.success) {
      return respondError(res, 400, "Invalid item id");
    }
    const item = await getGalleryItemById(pool, itemId.data);
    if (!item) {
      return respondError(res, 404, "Item not found");
    }
    const mapped = mapGalleryItem(item);
    res.json({ ok: true, data: { item: { ...mapped, viewUrl: buildComfyViewUrl(mapped) } } });
  })
);

app.post(
  "/api/gallery/items/:id/favorite",
  asyncHandler(async (req, res) => {
    const itemId = z.string().uuid().safeParse(req.params.id);
    if (!itemId.success) {
      return respondError(res, 400, "Invalid item id");
    }
    const parsed = galleryFavoriteSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const updated = await updateGalleryFavorite(pool, itemId.data, parsed.data.favorite);
    if (!updated) {
      return respondError(res, 404, "Item not found");
    }
    const mapped = mapGalleryItem(updated);
    res.json({ ok: true, data: { item: { ...mapped, viewUrl: buildComfyViewUrl(mapped) } } });
  })
);

app.patch(
  "/api/gallery/items/:id",
  asyncHandler(async (req, res) => {
    const itemId = z.string().uuid().safeParse(req.params.id);
    if (!itemId.success) {
      return respondError(res, 400, "Invalid item id");
    }
    const parsed = galleryItemUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const manualCkptName =
      parsed.data.manualCkptName === undefined
        ? undefined
        : parsed.data.manualCkptName === null
          ? null
          : parsed.data.manualCkptName.trim();
    const manualPositive =
      parsed.data.manualPositive === undefined
        ? undefined
        : parsed.data.manualPositive === null
          ? null
          : parsed.data.manualPositive.trim();
    const manualNegative =
      parsed.data.manualNegative === undefined
        ? undefined
        : parsed.data.manualNegative === null
          ? null
          : parsed.data.manualNegative.trim();
    const manualNotes =
      parsed.data.manualNotes === undefined
        ? undefined
        : parsed.data.manualNotes === null
          ? null
          : parsed.data.manualNotes.trim();

    const manualLoraNames =
      parsed.data.manualLoraNames === undefined
        ? undefined
        : parsed.data.manualLoraNames === null
          ? null
          : normalizeStringArray(parsed.data.manualLoraNames);
    const manualTags =
      parsed.data.manualTags === undefined
        ? undefined
        : parsed.data.manualTags === null
          ? null
          : normalizeStringArray(parsed.data.manualTags);

    const update = {
      manualCkptName,
      manualLoraNames,
      manualPositive,
      manualNegative,
      manualWidth: parsed.data.manualWidth,
      manualHeight: parsed.data.manualHeight,
      manualTags,
      manualNotes
    };

    const updated = await updateGalleryManualFields(pool, itemId.data, update);
    if (!updated) {
      return respondError(res, 404, "Item not found");
    }
    const mapped = mapGalleryItem(updated);
    res.json({ ok: true, data: { item: { ...mapped, viewUrl: buildComfyViewUrl(mapped) } } });
  })
);

app.post(
  "/api/gallery/items/:id/extract",
  asyncHandler(async (req, res) => {
    const itemId = z.string().uuid().safeParse(req.params.id);
    if (!itemId.success) {
      return respondError(res, 400, "Invalid item id");
    }
    const item = await getGalleryItemById(pool, itemId.data);
    if (!item) {
      return respondError(res, 404, "Item not found");
    }
    if (item.source_type !== "folder" || !item.source_id || !item.rel_path) {
      return respondError(res, 400, "source_type must be folder");
    }

    const source = await getGallerySourceById(pool, item.source_id);
    if (!source) {
      return respondError(res, 404, "Source not found");
    }
    const rootPath = resolveAbsolutePath(source.root_path);
    if (!rootPath) {
      return respondError(res, 400, "Invalid source root");
    }
    const filePath = path.resolve(rootPath, item.rel_path);
    const relative = path.relative(rootPath, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return respondError(res, 403, "Invalid path");
    }

    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(filePath);
    } catch (err) {
      return respondError(res, 404, "File not found", { error: err instanceof Error ? err.message : String(err) });
    }

    const extracted = extractImageMetadata(buffer);
    const parsedExtracted = extracted.parsed;
    const metaExtracted = {
      raw: extracted.raw,
      parsed: extracted.parsed,
      parseErrors: extracted.parseErrors,
      source: extracted.source
    };

    const ckptName = typeof parsedExtracted.ckpt === "string" ? parsedExtracted.ckpt.trim() || null : null;
    const loraNamesRaw = Array.isArray(parsedExtracted.loras)
      ? parsedExtracted.loras.map((name) => name.trim()).filter((name) => name.length > 0)
      : null;
    const loraNames = loraNamesRaw && loraNamesRaw.length > 0 ? loraNamesRaw : null;
    const positive = typeof parsedExtracted.positive === "string" ? parsedExtracted.positive.trim() || null : null;
    const negative = typeof parsedExtracted.negative === "string" ? parsedExtracted.negative.trim() || null : null;
    const width = typeof parsedExtracted.width === "number" && Number.isFinite(parsedExtracted.width) ? parsedExtracted.width : null;
    const height =
      typeof parsedExtracted.height === "number" && Number.isFinite(parsedExtracted.height) ? parsedExtracted.height : null;

    const updated = await updateGalleryExtractedFields(pool, itemId.data, {
      ckptName,
      loraNames,
      positive,
      negative,
      width,
      height,
      metaExtracted,
      needsReview: extracted.source === "none"
    });
    if (!updated) {
      return respondError(res, 404, "Item not found");
    }
    const mapped = mapGalleryItem(updated);
    res.json({ ok: true, data: { item: { ...mapped, viewUrl: buildComfyViewUrl(mapped) } } });
  })
);

app.delete(
  "/api/gallery/items/:id",
  asyncHandler(async (req, res) => {
    const itemId = z.string().uuid().safeParse(req.params.id);
    if (!itemId.success) {
      return respondError(res, 400, "Invalid item id");
    }
    const deleted = await deleteGalleryItem(pool, itemId.data);
    if (!deleted) {
      return respondError(res, 404, "Item not found");
    }
    res.json({ ok: true, data: { id: itemId.data } });
  })
);

app.get(
  "/api/gallery/items/:id/file",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const itemId = z.string().uuid().safeParse(req.params.id);
    if (!itemId.success) {
      return respondError(res, 400, "Invalid item id");
    }
    const item = await getGalleryItemById(pool, itemId.data);
    if (!item || item.source_type !== "folder" || !item.source_id || !item.rel_path) {
      return respondError(res, 404, "Item not found");
    }
    const source = await getGallerySourceById(pool, item.source_id);
    if (!source) {
      return respondError(res, 404, "Source not found");
    }
    const rootPath = resolveAbsolutePath(source.root_path);
    if (!rootPath) {
      return respondError(res, 400, "Invalid source root");
    }
    const filePath = path.resolve(rootPath, item.rel_path);
    const relative = path.relative(rootPath, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return respondError(res, 403, "Invalid path");
    }
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        return respondError(res, 404, "File not found");
      }
    } catch (err) {
      return respondError(res, 404, "File not found", { error: err instanceof Error ? err.message : String(err) });
    }
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) {
        respondError(res, 500, "File send failed", { error: err.message });
      }
    });
  })
);

app.get(
  "/api/gallery/sources",
  asyncHandler(async (_req, res) => {
    const sources = await listGallerySources(pool);
    res.json({ ok: true, data: { sources } });
  })
);

app.post(
  "/api/gallery/sources",
  asyncHandler(async (req, res) => {
    const parsed = gallerySourceCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const rootPath = resolveAbsolutePath(parsed.data.rootPath);
    if (!rootPath) {
      return respondError(res, 400, "rootPath must be absolute");
    }
    try {
      const stat = await fs.promises.stat(rootPath);
      if (!stat.isDirectory()) {
        return respondError(res, 400, "rootPath must be a directory");
      }
    } catch (err) {
      return respondError(res, 400, "rootPath not found", { error: err instanceof Error ? err.message : String(err) });
    }

    const source = await createGallerySource(pool, {
      name: parsed.data.name.trim(),
      rootPath,
      enabled: parsed.data.enabled ?? true,
      recursive: parsed.data.recursive ?? true,
      includeGlob: parsed.data.includeGlob?.trim() || null
    });
    res.status(201).json({ ok: true, data: { source } });
  })
);

app.put(
  "/api/gallery/sources/:id",
  asyncHandler(async (req, res) => {
    const sourceId = z.string().uuid().safeParse(req.params.id);
    if (!sourceId.success) {
      return respondError(res, 400, "Invalid source id");
    }
    const parsed = gallerySourceUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    let rootPath: string | undefined;
    if (parsed.data.rootPath !== undefined) {
      const resolved = resolveAbsolutePath(parsed.data.rootPath);
      if (!resolved) {
        return respondError(res, 400, "rootPath must be absolute");
      }
      try {
        const stat = await fs.promises.stat(resolved);
        if (!stat.isDirectory()) {
          return respondError(res, 400, "rootPath must be a directory");
        }
      } catch (err) {
        return respondError(res, 400, "rootPath not found", { error: err instanceof Error ? err.message : String(err) });
      }
      rootPath = resolved;
    }

    const updated = await updateGallerySource(pool, sourceId.data, {
      name: parsed.data.name?.trim(),
      rootPath,
      enabled: parsed.data.enabled,
      recursive: parsed.data.recursive,
      includeGlob: parsed.data.includeGlob !== undefined ? parsed.data.includeGlob.trim() || null : undefined
    });
    if (!updated) {
      return respondError(res, 404, "Source not found");
    }
    res.json({ ok: true, data: { source: updated } });
  })
);

app.delete(
  "/api/gallery/sources/:id",
  asyncHandler(async (req, res) => {
    const sourceId = z.string().uuid().safeParse(req.params.id);
    if (!sourceId.success) {
      return respondError(res, 400, "Invalid source id");
    }
    const deleted = await deleteGallerySource(pool, sourceId.data);
    if (!deleted) {
      return respondError(res, 404, "Source not found");
    }
    res.json({ ok: true, data: { id: sourceId.data } });
  })
);

app.post(
  "/api/gallery/sources/:id/scan",
  asyncHandler(async (req, res) => {
    const sourceId = z.string().uuid().safeParse(req.params.id);
    if (!sourceId.success) {
      return respondError(res, 400, "Invalid source id");
    }
    const source = await getGallerySourceById(pool, sourceId.data);
    if (!source) {
      return respondError(res, 404, "Source not found");
    }
    const result = await scanGallerySource(pool, source);
    if (!result.ok) {
      if (result.error === "scan_in_progress") {
        return respondError(res, 409, "scan_in_progress");
      }
      return respondError(res, 500, result.error);
    }
    res.json({ ok: true, data: result.result });
  })
);

app.get(
  "/api/llm/models",
  asyncHandler(async (_req, res) => {
    const url = `${OLLAMA_BASE_URL}/api/tags`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
      if (!response.ok) {
        const text = await response.text();
        return respondError(res, 502, "Failed to fetch models from Ollama", { status: response.status, body: text });
      }
      const data = (await response.json()) as { models?: any[] };
      const models = Array.isArray(data.models)
        ? data.models.map((m: any) => ({
            name: m.name,
            details: m.details ?? m.model ?? undefined,
            modified_at: m.modified_at ?? m.modifiedAt ?? undefined
          }))
        : [];
      res.json({ ok: true, data: { models } });
    } catch (err) {
      console.error("LLM models fetch failed", err);
      return respondError(res, 500, "Failed to fetch models from Ollama");
    }
  })
);

app.post(
  "/api/ollama/translate-tags",
  asyncHandler(async (req, res) => {
    const parsed = translateTagsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const force = parsed.data.force === true;
    const tags = parsed.data.tags
      .filter((tag) => typeof tag === "string")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    if (tags.length === 0) {
      return respondError(res, 400, "tags are required");
    }

    const uniqueTags = Array.from(new Set(tags));
    const translations: Record<string, string> = {};
    const now = Date.now();
    const pendingTags: string[] = [];

    if (force) {
      pendingTags.push(...uniqueTags);
    } else {
      for (const tag of uniqueTags) {
        const cached = translateCache.get(tag);
        if (cached && cached.expiresAt > now) {
          translations[tag] = cached.value;
        } else {
          pendingTags.push(tag);
        }
      }
    }

    if (pendingTags.length > 0) {
      const messages = buildTranslateMessages(pendingTags);
      const options = buildOllamaOptions();
      const controller = new AbortController();
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, OLLAMA_TIMEOUT_MS);
      let rawContent = "";

      try {
        const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: OLLAMA_TRANSLATE_MODEL,
            stream: false,
            messages,
            format: translateTagsFormat,
            keep_alive: OLLAMA_KEEP_ALIVE,
            options
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          const text = await response.text();
          const truncated = truncateText(text);
          clearTimeout(timeoutId);
          return respondError(res, 502, "Failed to call Ollama", {
            url: `${OLLAMA_BASE_URL}/api/chat`,
            status: response.status,
            body: truncated
          });
        }

        const data = (await response.json()) as { message?: { content?: string } };
        rawContent = data?.message?.content ?? "";
      } catch (err) {
        clearTimeout(timeoutId);
        const errName =
          err && typeof err === "object" && "name" in err && typeof (err as any).name === "string" ? (err as any).name : "";
        const isTimeout = timedOut || errName === "AbortError" || errName === "TimeoutError";
        return respondError(res, isTimeout ? 504 : 500, isTimeout ? "Ollama request timed out" : "Failed to call Ollama", {
          url: `${OLLAMA_BASE_URL}/api/chat`,
          error: err instanceof Error ? err.message : String(err),
          timeout_ms: OLLAMA_TIMEOUT_MS
        });
      } finally {
        clearTimeout(timeoutId);
      }

      const parsedTranslations = parseTranslateResponse(rawContent);
      if (!parsedTranslations) {
        return respondError(res, 500, "LLM returned invalid JSON", { raw: truncateText(rawContent, 4000) });
      }

      const expiresAt = Date.now() + TRANSLATE_CACHE_TTL_MS;
      for (const tag of pendingTags) {
        const raw = parsedTranslations[tag];
        const resolved = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : tag;
        translations[tag] = resolved;
        translateCache.set(tag, { value: resolved, expiresAt });
      }
    }

    res.json({ ok: true, data: { translations } });
  })
);

const createSessionSchema = z.object({
  mode: z.literal("MUSE"),
  title: z.string().trim().min(1).optional(),
  llmModel: z.string().trim().min(1).optional()
});

app.post(
  "/api/sessions",
  asyncHandler(async (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const { mode, title } = parsed.data;
    const llmModel = parsed.data.llmModel ?? DEFAULT_LLM_MODEL;

    const result = await pool.query(
      `INSERT INTO sessions (mode, title, llm_provider, llm_model, created_at, updated_at)
       VALUES ($1, $2, 'ollama', $3, NOW(), NOW())
       RETURNING *`,
      [mode, title ?? null, llmModel]
    );

    res.status(201).json({ ok: true, data: { session: result.rows[0] } });
  })
);

const updateSessionSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    llmModel: z.string().trim().min(1).optional()
  })
  .refine((data) => data.title !== undefined || data.llmModel !== undefined, {
    message: "Nothing to update"
  });

app.patch(
  "/api/sessions/:id",
  asyncHandler(async (req, res) => {
    const sessionId = z.string().uuid().safeParse(req.params.id);
    if (!sessionId.success) {
      return respondError(res, 400, "Invalid session id");
    }
    const parsed = updateSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT * FROM sessions WHERE id = $1", [sessionId.data]);
      if (existing.rowCount === 0) {
        await client.query("ROLLBACK");
        return respondError(res, 404, "Session not found");
      }
      const prev = existing.rows[0];

      const updates: string[] = [];
      const values: any[] = [];
      let idx = 1;
      if (parsed.data.title !== undefined) {
        updates.push(`title = $${idx++}`);
        values.push(parsed.data.title);
      }
      if (parsed.data.llmModel !== undefined) {
        updates.push(`llm_model = $${idx++}`);
        values.push(parsed.data.llmModel);
      }
      updates.push(`updated_at = NOW()`);
      values.push(sessionId.data);

      const updated = await client.query(
        `UPDATE sessions SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
        values
      );

      await logEvent(client, sessionId.data, "SESSION_UPDATED", {
        before: { title: prev.title, llm_model: prev.llm_model },
        after: { title: updated.rows[0].title, llm_model: updated.rows[0].llm_model }
      });

      await client.query("COMMIT");
      res.json({ ok: true, data: { session: updated.rows[0] } });
    } catch (err) {
      await client.query("ROLLBACK");
      await safeLogError(sessionId.data, err instanceof Error ? err.message : "Session update failed");
      throw err;
    } finally {
      client.release();
    }
  })
);

app.get(
  "/api/sessions",
  asyncHandler(async (_req, res) => {
    const result = await pool.query(`
      SELECT
        s.id,
        s.title,
        s.mode,
        s.llm_provider,
        s.llm_model,
        s.created_at,
        s.updated_at,
        COUNT(i.id) AS idea_count,
        COALESCE(SUM(CASE WHEN i.liked THEN 1 ELSE 0 END), 0) AS liked_count
      FROM sessions s
      LEFT JOIN ideas i ON i.session_id = s.id
      GROUP BY s.id, s.title, s.mode, s.llm_provider, s.llm_model, s.created_at, s.updated_at
      ORDER BY s.created_at DESC
    `);

    const sessions = result.rows.map((row: any) => ({
      ...row,
      idea_count: Number(row.idea_count),
      liked_count: Number(row.liked_count)
    }));

    res.json({ ok: true, data: { sessions } });
  })
);

app.get(
  "/api/sessions/:id",
  asyncHandler(async (req, res) => {
    const sessionId = z.string().uuid().safeParse(req.params.id);
    if (!sessionId.success) {
      return respondError(res, 400, "Invalid session id");
    }

    const sessionResult = await pool.query("SELECT * FROM sessions WHERE id = $1", [sessionId.data]);
    if (sessionResult.rowCount === 0) {
      return respondError(res, 404, "Session not found");
    }

    const ideasResult = await pool.query(
      "SELECT * FROM ideas WHERE session_id = $1 ORDER BY created_at ASC",
      [sessionId.data]
    );
    const eventsResult = await pool.query(
      "SELECT * FROM session_events WHERE session_id = $1 ORDER BY created_at ASC",
      [sessionId.data]
    );

    res.json({
      ok: true,
      data: {
        session: sessionResult.rows[0],
        ideas: ideasResult.rows,
        events: eventsResult.rows
      }
    });
  })
);

app.delete(
  "/api/sessions/:id/events",
  asyncHandler(async (req, res) => {
    const sessionId = z.string().uuid().safeParse(req.params.id);
    if (!sessionId.success) {
      return respondError(res, 400, "Invalid session id");
    }
    const exists = await pool.query("SELECT 1 FROM sessions WHERE id = $1", [sessionId.data]);
    if (exists.rowCount === 0) {
      return respondError(res, 404, "Session not found");
    }
    const result = await pool.query("DELETE FROM session_events WHERE session_id = $1", [sessionId.data]);
    res.json({ ok: true, data: { deleted: result.rowCount } });
  })
);

app.delete(
  "/api/sessions/:id",
  asyncHandler(async (req, res) => {
    const sessionId = z.string().uuid().safeParse(req.params.id);
    if (!sessionId.success) {
      return respondError(res, 400, "Invalid session id");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const exists = await client.query("SELECT 1 FROM sessions WHERE id = $1", [sessionId.data]);
      if (exists.rowCount === 0) {
        await client.query("ROLLBACK");
        return respondError(res, 404, "Session not found");
      }
      await client.query("DELETE FROM session_events WHERE session_id = $1", [sessionId.data]);
      await client.query("DELETE FROM ideas WHERE session_id = $1", [sessionId.data]);
      await client.query("DELETE FROM sessions WHERE id = $1", [sessionId.data]);
      await client.query("COMMIT");
      res.json({ ok: true, data: { id: sessionId.data } });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

const likeSchema = z.object({
  liked: z.boolean()
});

app.post(
  "/api/ideas/:id/like",
  asyncHandler(async (req, res) => {
    const ideaId = z.string().uuid().safeParse(req.params.id);
    if (!ideaId.success) {
      return respondError(res, 400, "Invalid idea id");
    }
    const parsed = likeSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const client = await pool.connect();
    let sessionIdForLog: string | null = null;
    try {
      await client.query("BEGIN");
      const ideaResult = await client.query("SELECT * FROM ideas WHERE id = $1", [ideaId.data]);
      if (ideaResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return respondError(res, 404, "Idea not found");
      }
      const existing = ideaResult.rows[0];
      sessionIdForLog = existing.session_id;

      const updated = await client.query("UPDATE ideas SET liked = $1 WHERE id = $2 RETURNING *", [
        parsed.data.liked,
        ideaId.data
      ]);

      await logEvent(client, existing.session_id, "IDEA_LIKED_TOGGLED", {
        idea_id: ideaId.data,
        liked: parsed.data.liked,
        previous_liked: existing.liked
      });

      await client.query("COMMIT");
      res.json({ ok: true, data: { idea: updated.rows[0] } });
    } catch (err) {
      await client.query("ROLLBACK");
      if (sessionIdForLog) {
        await safeLogError(sessionIdForLog, "Idea like failed", err);
      }
      throw err;
    } finally {
      client.release();
    }
  })
);

app.delete(
  "/api/ideas/:id",
  asyncHandler(async (req, res) => {
    const ideaId = z.string().uuid().safeParse(req.params.id);
    if (!ideaId.success) {
      return respondError(res, 400, "Invalid idea id");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ideaResult = await client.query("DELETE FROM ideas WHERE id = $1 RETURNING *", [ideaId.data]);
      if (ideaResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return respondError(res, 404, "Idea not found");
      }
      const deleted = ideaResult.rows[0];
      await logEvent(client, deleted.session_id, "IDEA_DELETED", { idea_id: ideaId.data });
      await client.query("COMMIT");
      res.json({ ok: true, data: { id: ideaId.data } });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

app.get(
  "/api/ideas",
  asyncHandler(async (req, res) => {
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid query", parsed.error.flatten());
    }
    const data = parsed.data;
    if (!data.liked) {
      return respondError(res, 400, "Only liked=true is supported");
    }
    const limit = data.limit ?? 50;
    const offset = data.offset ?? 0;

    const result = await pool.query(
      `
      SELECT
        i.*,
        s.title AS session_title,
        s.llm_model AS session_llm_model
      FROM ideas i
      JOIN sessions s ON s.id = i.session_id
      WHERE i.liked = TRUE
      ORDER BY i.created_at DESC
      LIMIT $1 OFFSET $2
    `,
      [limit, offset]
    );

    res.json({
      ok: true,
      data: {
        ideas: result.rows
      }
    });
  })
);

const recipeLoraSelectQuery = `
  SELECT
    rl.recipe_id,
    rl.lora_id,
    rl.weight,
    rl.usage_notes,
    rl.sort_order,
    l.name AS lora_name,
    l.trigger_words,
    l.recommended_weight_min,
    l.recommended_weight_max,
    l.notes AS lora_notes,
    l.tags AS lora_tags,
    l.example_prompts,
    l.thumbnail_key AS lora_thumbnail_key,
    l.created_at AS lora_created_at,
    l.updated_at AS lora_updated_at
  FROM recipe_loras rl
  JOIN loras l ON l.id = rl.lora_id
  WHERE rl.recipe_id = $1
`;

type RecipeRunConfig = {
  input: ComfyRunCreateInput;
  initImageName: string | null;
  controlnetImageName: string | null;
  recipeSnapshot: Record<string, unknown>;
};

const buildRecipeRunConfig = async (recipe: any, recipeLoras: any[]): Promise<RecipeRunConfig> => {
  const defaults = await getComfyTemplateDefaults();
  const promptBlocks = asRecord(recipe?.prompt_blocks) ?? {};
  const variables = getRecipeComfyConfig(recipe?.variables);
  const controlnetConfig = asRecord(variables.controlnet) ?? {};
  const i2iConfig = asRecord(variables.i2i) ?? asRecord(variables.image2i) ?? {};
  const advancedConfig = asRecord(variables.advanced) ?? {};
  const ksamplerConfig = asRecord(variables.ksampler) ?? asRecord(advancedConfig.ksampler) ?? advancedConfig;

  const positive = readOptionalString(promptBlocks.positive) ?? defaults.efficientLoaderDefaults.positive ?? "";
  const negative = readOptionalString(promptBlocks.negative) ?? defaults.efficientLoaderDefaults.negative ?? "";
  const ckptName = defaults.efficientLoaderDefaults.ckptName ?? "";
  const width = Math.trunc(defaults.efficientLoaderDefaults.width ?? 0);
  const height = Math.trunc(defaults.efficientLoaderDefaults.height ?? 0);

  const initImageName =
    readOptionalString(i2iConfig.initImage ?? i2iConfig.image ?? variables.initImage ?? variables.init_image) ?? null;
  const modeHint = readOptionalString(variables.mode);
  const workflowHint = readOptionalString(variables.workflowId ?? variables.workflow_id ?? variables.workflow);
  const i2iEnabled = readOptionalBoolean(
    i2iConfig.enabled ?? variables.i2iEnabled ?? variables.image2iEnabled ?? variables.useImage2i
  );
  const useImage2i =
    workflowHint === "base_image2i" || modeHint === "image2i" || modeHint === "i2i" || Boolean(i2iEnabled) || Boolean(initImageName);
  const workflowId = useImage2i ? "base_image2i" : "base_text2i";

  const controlnetEnabledRaw = readOptionalBoolean(
    controlnetConfig.enabled ?? variables.controlnetEnabled ?? variables.controlnet_enabled
  );
  const controlnetEnabled = controlnetEnabledRaw ?? defaults.controlnetDefaults.enabled;
  const controlnetModel =
    readOptionalString(
      controlnetConfig.model ?? controlnetConfig.modelName ?? variables.controlnetModel ?? variables.controlnet_model
    ) ?? defaults.controlnetDefaults.modelName;
  const preprocessorEnabled =
    readOptionalBoolean(
      controlnetConfig.preprocessorEnabled ?? variables.preprocessorEnabled ?? variables.preprocessor_enabled
    ) ?? false;
  const preprocessor =
    readOptionalString(controlnetConfig.preprocessor ?? variables.preprocessor) ?? defaults.controlnetDefaults.preprocessor;
  const controlnetStrength =
    readOptionalNumber(controlnetConfig.strength ?? variables.controlnetStrength ?? variables.controlnet_strength) ??
    defaults.controlnetDefaults.strength;
  const controlnetImageName =
    readOptionalString(
      controlnetConfig.image ?? controlnetConfig.imageName ?? variables.controlnetImage ?? variables.controlnet_image
    ) ?? readOptionalString(defaults.controlnetDefaults.imageName ?? undefined) ?? null;

  const loras = recipeLoras
    .map((link: any) => {
      const name = readOptionalString(link.lora_name ?? link.name);
      if (!name) return null;
      const weight = Number.isFinite(Number(link.weight)) ? Number(link.weight) : 1;
      return { name, weight, enabled: true };
    })
    .filter((item: any) => item !== null);

  const loraInputs =
    loras.length > 0
      ? (loras as { name: string; weight: number; enabled: boolean }[])
      : defaults.loraDefaults.map((item) => ({ name: item.name, weight: item.weight, enabled: true }));

  const ksampler: Record<string, unknown> = {};
  const stepsValue = readOptionalNumber(ksamplerConfig.steps);
  if (stepsValue !== undefined) ksampler.steps = Math.trunc(stepsValue);
  const cfgValue = readOptionalNumber(ksamplerConfig.cfg);
  if (cfgValue !== undefined) ksampler.cfg = cfgValue;
  const samplerName = readOptionalString(ksamplerConfig.sampler_name ?? ksamplerConfig.sampler);
  if (samplerName) ksampler.sampler_name = samplerName;
  const schedulerValue = readOptionalString(ksamplerConfig.scheduler);
  if (schedulerValue) ksampler.scheduler = schedulerValue;
  const seedValue = readOptionalNumber(ksamplerConfig.seed);
  if (seedValue !== undefined) ksampler.seed = Math.trunc(seedValue);
  const denoiseValue = readOptionalNumber(ksamplerConfig.denoise);
  if (denoiseValue !== undefined) ksampler.denoise = denoiseValue;
  const ksamplerPayload = Object.keys(ksampler).length > 0 ? (ksampler as ComfyRunCreateInput["ksampler"]) : undefined;

  const input: ComfyRunCreateInput = {
    workflowId,
    positive,
    negative,
    ckptName,
    width,
    height,
    loras: loraInputs,
    controlnetEnabled,
    controlnetModel,
    preprocessorEnabled,
    preprocessor,
    controlnetStrength,
    ksampler: ksamplerPayload
  };

  return {
    input,
    initImageName,
    controlnetImageName,
    recipeSnapshot: { recipe, loras: recipeLoras }
  };
};

const mapLoraRow = (row: Record<string, any>) => ({
  ...row,
  fileName: row.file_name ?? null
});

app.get(
  "/api/loras",
  asyncHandler(async (_req, res) => {
    const result = await pool.query("SELECT * FROM loras ORDER BY created_at DESC");
    res.json({ ok: true, data: { loras: result.rows.map(mapLoraRow) } });
  })
);

app.post(
  "/api/loras",
  asyncHandler(async (req, res) => {
    const parsed = loraCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const data = parsed.data;
    const fileName = normalizeOptionalFileName(data.fileName);
    const triggerWords = normalizeStringArray(data.triggerWords);
    const tags = normalizeStringArray(data.tags);
    const examplePrompts = normalizeStringArray(data.examplePrompts);

    const result = await pool.query(
      `
      INSERT INTO loras (name, file_name, trigger_words, recommended_weight_min, recommended_weight_max, notes, tags, example_prompts, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      RETURNING *
    `,
      [
        data.name,
        fileName,
        triggerWords,
        data.recommendedWeightMin ?? null,
        data.recommendedWeightMax ?? null,
        data.notes ?? null,
        tags,
        examplePrompts
      ]
    );

    res.status(201).json({ ok: true, data: { lora: mapLoraRow(result.rows[0]) } });
  })
);

app.get(
  "/api/loras/:id",
  asyncHandler(async (req, res) => {
    const loraId = z.string().uuid().safeParse(req.params.id);
    if (!loraId.success) {
      return respondError(res, 400, "Invalid lora id");
    }
    const result = await pool.query("SELECT * FROM loras WHERE id = $1", [loraId.data]);
    if (result.rowCount === 0) {
      return respondError(res, 404, "LoRA not found");
    }
    res.json({ ok: true, data: { lora: mapLoraRow(result.rows[0]) } });
  })
);

app.patch(
  "/api/loras/:id",
  asyncHandler(async (req, res) => {
    const loraId = z.string().uuid().safeParse(req.params.id);
    if (!loraId.success) {
      return respondError(res, 400, "Invalid lora id");
    }
    const parsed = loraUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;
    if (parsed.data.name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(parsed.data.name);
    }
    if (parsed.data.fileName !== undefined) {
      updates.push(`file_name = $${idx++}`);
      values.push(normalizeOptionalFileName(parsed.data.fileName));
    }
    if (parsed.data.triggerWords !== undefined) {
      updates.push(`trigger_words = $${idx++}`);
      values.push(normalizeStringArray(parsed.data.triggerWords));
    }
    if (parsed.data.recommendedWeightMin !== undefined) {
      updates.push(`recommended_weight_min = $${idx++}`);
      values.push(parsed.data.recommendedWeightMin);
    }
    if (parsed.data.recommendedWeightMax !== undefined) {
      updates.push(`recommended_weight_max = $${idx++}`);
      values.push(parsed.data.recommendedWeightMax);
    }
    if (parsed.data.notes !== undefined) {
      updates.push(`notes = $${idx++}`);
      values.push(parsed.data.notes);
    }
    if (parsed.data.tags !== undefined) {
      updates.push(`tags = $${idx++}`);
      values.push(normalizeStringArray(parsed.data.tags));
    }
    if (parsed.data.examplePrompts !== undefined) {
      updates.push(`example_prompts = $${idx++}`);
      values.push(normalizeStringArray(parsed.data.examplePrompts));
    }
    updates.push(`updated_at = NOW()`);
    values.push(loraId.data);

    const result = await pool.query(`UPDATE loras SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`, values);
    if (result.rowCount === 0) {
      return respondError(res, 404, "LoRA not found");
    }
    res.json({ ok: true, data: { lora: mapLoraRow(result.rows[0]) } });
  })
);

app.post(
  "/api/loras/:id/thumbnail",
  asyncHandler(async (req, res) => {
    const loraId = z.string().uuid().safeParse(req.params.id);
    if (!loraId.success) {
      return respondError(res, 400, "Invalid lora id");
    }
    const existing = await pool.query("SELECT * FROM loras WHERE id = $1", [loraId.data]);
    if (existing.rowCount === 0) {
      return respondError(res, 404, "LoRA not found");
    }

    try {
      await runMulterSingle(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid upload";
      return respondError(res, 400, "Invalid upload", { message });
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      return respondError(res, 400, "File is required");
    }
    const ext = ALLOWED_IMAGE_MIME.get(file.mimetype) ?? path.extname(file.originalname).replace(/^\.+/, "");
    const safeExt = ext ? (ext.startsWith(".") ? ext : `.${ext}`) : ".bin";
    const filename = `lora_${loraId.data}_${Date.now()}${safeExt}`;
    const key = path.posix.join("lora_thumbs", filename);
    const filePath = resolveMediaPath(key);
    if (!filePath) {
      return respondError(res, 500, "Invalid media path");
    }

    await fs.promises.mkdir(LORA_THUMBS_DIR, { recursive: true });
    await fs.promises.writeFile(filePath, file.buffer);
    await deleteFileSafe(existing.rows[0].thumbnail_key);

    const updated = await pool.query("UPDATE loras SET thumbnail_key = $1, updated_at = NOW() WHERE id = $2 RETURNING *", [
      key,
      loraId.data
    ]);

    res.json({
      ok: true,
      data: { thumbnailKey: key, url: `/media/${encodeMediaKey(key)}`, lora: mapLoraRow(updated.rows[0]) }
    });
  })
);

app.delete(
  "/api/loras/:id",
  asyncHandler(async (req, res) => {
    const loraId = z.string().uuid().safeParse(req.params.id);
    if (!loraId.success) {
      return respondError(res, 400, "Invalid lora id");
    }
    const existing = await pool.query("SELECT thumbnail_key FROM loras WHERE id = $1", [loraId.data]);
    if (existing.rowCount === 0) {
      return respondError(res, 404, "LoRA not found");
    }
    await deleteFileSafe(existing.rows[0].thumbnail_key);
    const result = await pool.query("DELETE FROM loras WHERE id = $1", [loraId.data]);
    res.json({ ok: true, data: { id: loraId.data } });
  })
);

app.get(
  "/api/recipes",
  asyncHandler(async (_req, res) => {
    const result = await pool.query(`
      SELECT r.*, COUNT(rl.lora_id) AS lora_count
      FROM recipes r
      LEFT JOIN recipe_loras rl ON rl.recipe_id = r.id
      GROUP BY r.id
      ORDER BY r.updated_at DESC, r.created_at DESC
    `);
    const recipes = result.rows.map((row: any) => ({
      ...row,
      lora_count: Number(row.lora_count)
    }));
    res.json({ ok: true, data: { recipes } });
  })
);

app.post(
  "/api/recipes",
  asyncHandler(async (req, res) => {
    const parsed = recipeCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const data = parsed.data;

    let promptBlocks = data.promptBlocks;
    let sourceIdeaId: string | null = data.sourceIdeaId ?? null;
    let title: string | null = data.title ?? null;
    let tags = normalizeStringArray(data.tags);
    const variables = data.variables ?? {};
    const pinned = data.pinned ?? false;

    if (!promptBlocks && sourceIdeaId) {
      const ideaResult = await pool.query("SELECT * FROM ideas WHERE id = $1", [sourceIdeaId]);
      if (ideaResult.rowCount === 0) {
        return respondError(res, 404, "Idea not found for import");
      }
      const idea = ideaResult.rows[0];
      promptBlocks = {
        positive: idea.prompt_snippet || idea.description || "",
        negative: "",
        notes: idea.description || null
      };
      title = title ?? idea.title ?? null;
      if (tags.length === 0 && Array.isArray(idea.tags)) {
        tags = normalizeStringArray(idea.tags);
      }
    }

    if (!promptBlocks) {
      return respondError(res, 400, "promptBlocks is required");
    }

    const result = await pool.query(
      `
      INSERT INTO recipes (title, source_idea_id, target, prompt_blocks, variables, tags, pinned, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      RETURNING *
    `,
      [title ?? null, sourceIdeaId, data.target, promptBlocks, variables, tags, pinned]
    );

    res.status(201).json({ ok: true, data: { recipe: result.rows[0] } });
  })
);

app.get(
  "/api/recipes/:id",
  asyncHandler(async (req, res) => {
    const recipeId = z.string().uuid().safeParse(req.params.id);
    if (!recipeId.success) {
      return respondError(res, 400, "Invalid recipe id");
    }
    const recipeResult = await pool.query("SELECT * FROM recipes WHERE id = $1", [recipeId.data]);
    if (recipeResult.rowCount === 0) {
      return respondError(res, 404, "Recipe not found");
    }
    const loraResult = await pool.query(`${recipeLoraSelectQuery} ORDER BY rl.sort_order ASC, l.name ASC`, [recipeId.data]);
    res.json({ ok: true, data: { recipe: recipeResult.rows[0], loras: loraResult.rows } });
  })
);

app.post(
  "/api/workshop/recipes/:id/run",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const recipeId = z.string().uuid().safeParse(req.params.id);
    if (!recipeId.success) {
      return respondError(res, 400, "Invalid recipe id");
    }
    const recipeResult = await pool.query("SELECT * FROM recipes WHERE id = $1", [recipeId.data]);
    if (recipeResult.rowCount === 0) {
      return respondError(res, 404, "Recipe not found");
    }

    const loraResult = await pool.query(`${recipeLoraSelectQuery} ORDER BY rl.sort_order ASC, l.name ASC`, [recipeId.data]);
    let config: RecipeRunConfig;
    try {
      config = await buildRecipeRunConfig(recipeResult.rows[0], loraResult.rows);
    } catch (err) {
      return respondError(res, 500, "Failed to build recipe run", {
        error: err instanceof Error ? err.message : String(err)
      });
    }

    const parsed = comfyRunCreateSchema.safeParse(config.input);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid recipe run configuration", parsed.error.flatten());
    }
    if (parsed.data.workflowId === "base_image2i" && !config.initImageName) {
      return respondError(res, 400, "initImage is required for image2i");
    }

    const created = await createComfyRun(parsed.data, {
      initImageName: config.initImageName,
      controlnetImageName: config.controlnetImageName,
      recipeId: recipeId.data,
      recipeSnapshot: config.recipeSnapshot
    });
    if (!created.ok) {
      return respondError(res, created.error.status, created.error.message, created.error.details);
    }

    res.status(201).json({ ok: true, data: { run: created.run } });
  })
);

app.patch(
  "/api/recipes/:id",
  asyncHandler(async (req, res) => {
    const recipeId = z.string().uuid().safeParse(req.params.id);
    if (!recipeId.success) {
      return respondError(res, 400, "Invalid recipe id");
    }
    const parsed = recipeUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const existing = await pool.query("SELECT 1 FROM recipes WHERE id = $1", [recipeId.data]);
    if (existing.rowCount === 0) {
      return respondError(res, 404, "Recipe not found");
    }

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;
    if (parsed.data.title !== undefined) {
      updates.push(`title = $${idx++}`);
      values.push(parsed.data.title ?? null);
    }
    if (parsed.data.target !== undefined) {
      updates.push(`target = $${idx++}`);
      values.push(parsed.data.target);
    }
    if (parsed.data.promptBlocks !== undefined) {
      updates.push(`prompt_blocks = $${idx++}`);
      values.push(parsed.data.promptBlocks);
    }
    if (parsed.data.variables !== undefined) {
      updates.push(`variables = $${idx++}`);
      values.push(parsed.data.variables);
    }
    if (parsed.data.tags !== undefined) {
      updates.push(`tags = $${idx++}`);
      values.push(normalizeStringArray(parsed.data.tags));
    }
    if (parsed.data.pinned !== undefined) {
      updates.push(`pinned = $${idx++}`);
      values.push(parsed.data.pinned);
    }
    if (parsed.data.sourceIdeaId !== undefined) {
      updates.push(`source_idea_id = $${idx++}`);
      values.push(parsed.data.sourceIdeaId ?? null);
    }
    updates.push("updated_at = NOW()");
    values.push(recipeId.data);

    const updated = await pool.query(`UPDATE recipes SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`, values);
    res.json({ ok: true, data: { recipe: updated.rows[0] } });
  })
);

app.delete(
  "/api/recipes/:id",
  asyncHandler(async (req, res) => {
    const recipeId = z.string().uuid().safeParse(req.params.id);
    if (!recipeId.success) {
      return respondError(res, 400, "Invalid recipe id");
    }
    const existing = await pool.query("SELECT thumbnail_key FROM recipes WHERE id = $1", [recipeId.data]);
    if (existing.rowCount === 0) {
      return respondError(res, 404, "Recipe not found");
    }
    await deleteFileSafe(existing.rows[0].thumbnail_key);
    const result = await pool.query("DELETE FROM recipes WHERE id = $1", [recipeId.data]);
    res.json({ ok: true, data: { id: recipeId.data } });
  })
);

app.post(
  "/api/recipes/:id/loras",
  asyncHandler(async (req, res) => {
    const recipeId = z.string().uuid().safeParse(req.params.id);
    if (!recipeId.success) {
      return respondError(res, 400, "Invalid recipe id");
    }
    const parsed = recipeLoraUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const recipeExists = await client.query("SELECT 1 FROM recipes WHERE id = $1", [recipeId.data]);
      if (recipeExists.rowCount === 0) {
        await client.query("ROLLBACK");
        return respondError(res, 404, "Recipe not found");
      }
      const loraExists = await client.query("SELECT 1 FROM loras WHERE id = $1", [parsed.data.loraId]);
      if (loraExists.rowCount === 0) {
        await client.query("ROLLBACK");
        return respondError(res, 404, "LoRA not found");
      }

      await client.query(
        `
        INSERT INTO recipe_loras (recipe_id, lora_id, weight, usage_notes, sort_order)
        VALUES ($1, $2, $3, $4, COALESCE($5, 0))
        ON CONFLICT (recipe_id, lora_id) DO UPDATE
          SET weight = EXCLUDED.weight,
              usage_notes = EXCLUDED.usage_notes,
              sort_order = EXCLUDED.sort_order
      `,
        [
          recipeId.data,
          parsed.data.loraId,
          parsed.data.weight ?? null,
          parsed.data.usageNotes ?? null,
          parsed.data.sortOrder ?? 0
        ]
      );
      await client.query("UPDATE recipes SET updated_at = NOW() WHERE id = $1", [recipeId.data]);

      const link = await client.query(`${recipeLoraSelectQuery} AND rl.lora_id = $2`, [
        recipeId.data,
        parsed.data.loraId
      ]);

      await client.query("COMMIT");
      res.status(201).json({ ok: true, data: { lora: link.rows[0] } });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

app.delete(
  "/api/recipes/:id/loras/:loraId",
  asyncHandler(async (req, res) => {
    const recipeId = z.string().uuid().safeParse(req.params.id);
    const loraId = z.string().uuid().safeParse(req.params.loraId);
    if (!recipeId.success || !loraId.success) {
      return respondError(res, 400, "Invalid id");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const deleted = await client.query("DELETE FROM recipe_loras WHERE recipe_id = $1 AND lora_id = $2", [
        recipeId.data,
        loraId.data
      ]);
      if (deleted.rowCount === 0) {
        await client.query("ROLLBACK");
        return respondError(res, 404, "Relation not found");
      }
      await client.query("UPDATE recipes SET updated_at = NOW() WHERE id = $1", [recipeId.data]);
      await client.query("COMMIT");
      res.json({ ok: true, data: { recipeId: recipeId.data, loraId: loraId.data } });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

app.post(
  "/api/recipes/:id/thumbnail",
  asyncHandler(async (req, res) => {
    const recipeId = z.string().uuid().safeParse(req.params.id);
    if (!recipeId.success) {
      return respondError(res, 400, "Invalid recipe id");
    }
    const existing = await pool.query("SELECT * FROM recipes WHERE id = $1", [recipeId.data]);
    if (existing.rowCount === 0) {
      return respondError(res, 404, "Recipe not found");
    }

    try {
      await runMulterSingle(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid upload";
      return respondError(res, 400, "Invalid upload", { message });
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      return respondError(res, 400, "File is required");
    }
    const ext = ALLOWED_IMAGE_MIME.get(file.mimetype) ?? path.extname(file.originalname).replace(/^\.+/, "");
    const safeExt = ext ? (ext.startsWith(".") ? ext : `.${ext}`) : ".bin";
    const filename = `recipe_${recipeId.data}_${Date.now()}${safeExt}`;
    const key = path.posix.join("recipe_thumbs", filename);
    const filePath = resolveMediaPath(key);
    if (!filePath) {
      return respondError(res, 500, "Invalid media path");
    }

    await fs.promises.mkdir(RECIPE_THUMBS_DIR, { recursive: true });
    await fs.promises.writeFile(filePath, file.buffer);
    await deleteFileSafe(existing.rows[0].thumbnail_key);

    const updated = await pool.query(
      "UPDATE recipes SET thumbnail_key = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
      [key, recipeId.data]
    );

    res.json({
      ok: true,
      data: { thumbnailKey: key, url: `/media/${encodeMediaKey(key)}`, recipe: updated.rows[0] }
    });
  })
);

const museGenerateSchema = z.object({
  sessionId: z.string().uuid(),
  theme: z.string().trim().min(1).optional(),
  count: z.coerce.number().int().min(1).max(10)
});

const paginationSchema = z.object({
  liked: z
    .string()
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const galleryListSchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  ckpt: z.string().trim().min(1).optional(),
  lora: z.union([z.string(), z.array(z.string())]).optional(),
  w: z.coerce.number().int().min(1).optional(),
  h: z.coerce.number().int().min(1).optional(),
  dateFrom: z.string().trim().min(1).optional(),
  dateTo: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  favorited: z.union([z.string(), z.boolean()]).optional()
});

const comfyRunsListSchema = z.object({
  recipeId: z.preprocess(
    (value) => {
      if (Array.isArray(value)) return value[0];
      if (typeof value === "string" && value.trim() === "") return undefined;
      return value;
    },
    z.string().uuid().optional()
  )
});

const galleryFavoriteSchema = z.object({
  favorite: z.boolean().optional()
}).default({});

const galleryItemUpdateSchema = z
  .object({
    manualCkptName: z.string().nullable().optional(),
    manualLoraNames: z.array(z.string()).nullable().optional(),
    manualPositive: z.string().nullable().optional(),
    manualNegative: z.string().nullable().optional(),
    manualWidth: z.union([z.coerce.number().int().min(1), z.null()]).optional(),
    manualHeight: z.union([z.coerce.number().int().min(1), z.null()]).optional(),
    manualTags: z.array(z.string()).nullable().optional(),
    manualNotes: z.string().nullable().optional()
  })
  .refine(
    (data) =>
      data.manualCkptName !== undefined ||
      data.manualLoraNames !== undefined ||
      data.manualPositive !== undefined ||
      data.manualNegative !== undefined ||
      data.manualWidth !== undefined ||
      data.manualHeight !== undefined ||
      data.manualTags !== undefined ||
      data.manualNotes !== undefined,
    {
      message: "Nothing to update"
    }
  );

const gallerySourceCreateSchema = z.object({
  name: z.string().trim().min(1),
  rootPath: z.string().trim().min(1),
  enabled: z.boolean().optional(),
  recursive: z.boolean().optional(),
  includeGlob: z.string().trim().optional()
});

const gallerySourceUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  rootPath: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  recursive: z.boolean().optional(),
  includeGlob: z.string().trim().optional()
});

const tagQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const tagSearchQuerySchema = z.object({
  query: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const tagDictionaryUpsertSchema = z.object({
  tag: z.string().trim().min(1),
  type: z.string().trim().optional(),
  count: z.coerce.number().int().min(0).optional(),
  aliases: z.array(z.string()).optional()
});

const tagDictionaryBulkSchema = z.object({
  items: z.array(tagDictionaryUpsertSchema).min(1).max(1000),
  mode: z.enum(["upsert", "replace"]).optional()
});

const tagTranslationUpsertSchema = z.object({
  tag: z.string().trim().min(1),
  ja: z.string().trim().min(1),
  source: z.string().trim().min(1).optional()
});

const tagTranslationBulkSchema = z.object({
  items: z.array(tagTranslationUpsertSchema).min(1).max(500)
});

const tagTranslationLookupSchema = z.object({
  tags: z.array(z.string()).min(1).max(200)
});

const promptTagGroupCreateSchema = z.object({
  label: z.string().trim().min(1),
  sortOrder: z.coerce.number().int().optional(),
  filter: z.record(z.any()).optional()
});

const promptTagGroupUpdateSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    sortOrder: z.coerce.number().int().optional(),
    filter: z.record(z.any()).optional()
  })
  .refine((data) => data.label !== undefined || data.sortOrder !== undefined || data.filter !== undefined, {
    message: "Nothing to update"
  });

const promptTagGroupOverrideSchema = z.object({
  groupId: z.union([z.coerce.number().int().min(1), z.null()])
});

const promptConflictCreateSchema = z.object({
  a: z.string().trim().min(1),
  b: z.string().trim().min(1),
  severity: z.enum(["warn"]).optional(),
  message: z.string().trim().optional()
});

const promptTemplateCreateSchema = z.object({
  name: z.string().trim().min(1),
  target: z.enum(["positive", "negative", "both"]),
  tokens: z.array(z.string().trim().min(1)).min(1),
  sortOrder: z.coerce.number().int().optional()
});

const promptTemplateUpdateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    target: z.enum(["positive", "negative", "both"]).optional(),
    tokens: z.array(z.string().trim().min(1)).min(1).optional(),
    sortOrder: z.coerce.number().int().optional()
  })
  .refine(
    (data) => data.name !== undefined || data.target !== undefined || data.tokens !== undefined || data.sortOrder !== undefined,
    {
      message: "Nothing to update"
    }
  );

app.post(
  "/api/muse/generate",
  asyncHandler(async (req, res) => {
    const parsed = museGenerateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const { sessionId, theme, count } = parsed.data;

    const sessionResult = await pool.query("SELECT * FROM sessions WHERE id = $1", [sessionId]);
    if (sessionResult.rowCount === 0) {
      return respondError(res, 404, "Session not found");
    }
    const session = sessionResult.rows[0];

    const messages = [
      {
        role: "system",
        content:
          "You are CG Muse, an assistant that only responds with JSON matching the provided schema. Do not include explanations or markdown."
      },
      {
        role: "user",
        content: [
          "Generate concise CG creation ideas.",
          theme ? `Theme: ${theme}` : "Theme: Freestyle",
          `Need ${count} ideas. Each requires title, description (2-4 sentences), prompt_snippet (one line), and tags (Japanese keywords).`
        ].join("\n")
      }
    ];

    const schema = buildIdeasJsonSchema(count);
    const options = buildOllamaOptions();
    const requestId = randomUUID();
    const llmRequestPayload = {
      request_id: requestId,
      model: session.llm_model,
      theme: theme ?? null,
      count,
      messages,
      schema,
      options,
      keep_alive: OLLAMA_KEEP_ALIVE
    };

    await logEvent(pool, sessionId, "LLM_REQUEST", llmRequestPayload);

    let rawContent = "";
    const abortController = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      if (abortController.signal.aborted) return;
      timedOut = true;
      abortController.abort();
    }, OLLAMA_TIMEOUT_MS);
    let clientAborted = false;
    let cancellationLogged = false;

    const logCancellationIfNeeded = async () => {
      if (cancellationLogged) return;
      cancellationLogged = true;
      await logEvent(pool, sessionId, "CANCELLED", {
        request_id: requestId,
        reason: "client_aborted"
      });
    };

    const onClose = () => {
      if (clientAborted) return;
      clientAborted = true;
      abortController.abort();
    };
    req.on("close", onClose);

    const cleanupAbortListener = () => {
      clearTimeout(timeoutId);
      if (typeof req.off === "function") {
        req.off("close", onClose);
      } else {
        req.removeListener("close", onClose);
      }
    };

    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: session.llm_model,
          stream: false,
          messages,
          format: schema,
          keep_alive: OLLAMA_KEEP_ALIVE,
          options
        }),
        signal: abortController.signal
      });

      if (!response.ok) {
        const text = await response.text();
        const truncated = truncateText(text);
        await safeLogError(sessionId, "Ollama chat failed", {
          url: `${OLLAMA_BASE_URL}/api/chat`,
          status: response.status,
          body: truncated,
          request_id: requestId
        });
        cleanupAbortListener();
        return respondError(res, 502, "Failed to call Ollama", {
          url: `${OLLAMA_BASE_URL}/api/chat`,
          status: response.status,
          body: truncated
        });
      }

      const data = (await response.json()) as { message?: { content?: string } };
      rawContent = data?.message?.content ?? "";
    } catch (err) {
      cleanupAbortListener();
      if (clientAborted || (err instanceof Error && err.name === "AbortError")) {
        await logCancellationIfNeeded();
        return res.status(499).json({ ok: false, error: { message: "Request cancelled by client" } });
      }
      await safeLogError(sessionId, "Ollama chat failed", err);
      const errName =
        err && typeof err === "object" && "name" in err && typeof (err as any).name === "string" ? (err as any).name : "";
      const isTimeout = timedOut || errName === "TimeoutError";
      return respondError(res, isTimeout ? 504 : 500, isTimeout ? "Ollama request timed out" : "Failed to call Ollama", {
        url: `${OLLAMA_BASE_URL}/api/chat`,
        error: err instanceof Error ? err.message : String(err),
        timeout_ms: OLLAMA_TIMEOUT_MS
      });
    }
    cleanupAbortListener();

    const truncatedRaw = truncateText(rawContent);
    let parsedIdeas: z.infer<ReturnType<typeof ideasZodSchema>>;

    try {
      const content = typeof rawContent === "string" && rawContent.trim() ? rawContent : "null";
      const parsedJson = JSON.parse(content);
      const normalized = Array.isArray(parsedJson) ? { ideas: parsedJson } : parsedJson;
      const validated = ideasZodSchema(count).safeParse(normalized);
      if (!validated.success) {
        await logEvent(pool, sessionId, "LLM_RESPONSE", {
          request_id: requestId,
          raw: truncatedRaw,
          summary: { parse_error: validated.error.flatten() }
        });
        await safeLogError(sessionId, "LLM returned invalid JSON", {
          request_id: requestId,
          details: validated.error.flatten()
        });
        return respondError(res, 500, "LLM returned invalid JSON");
      }
      parsedIdeas = validated.data;
    } catch (err) {
      await logEvent(pool, sessionId, "LLM_RESPONSE", {
        request_id: requestId,
        raw: truncatedRaw,
        summary: { parse_error: err instanceof Error ? err.message : String(err) }
      });
      await safeLogError(sessionId, "LLM returned invalid JSON", {
        request_id: requestId,
        error: err instanceof Error ? err.message : err
      });
      return respondError(res, 500, "LLM returned invalid JSON");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await logEvent(client, sessionId, "LLM_RESPONSE", {
        request_id: requestId,
        raw: truncatedRaw,
        summary: { idea_count: parsedIdeas.ideas.length }
      });

      const insertedIdeas = [];
      for (const idea of parsedIdeas.ideas) {
        const insert = await client.query(
          `INSERT INTO ideas (session_id, title, description, prompt_snippet, tags, liked, created_at)
           VALUES ($1, $2, $3, $4, $5, FALSE, NOW())
           RETURNING *`,
          [sessionId, idea.title, idea.description, idea.prompt_snippet, idea.tags]
        );
        insertedIdeas.push(insert.rows[0]);
      }

      await logEvent(client, sessionId, "IDEA_GENERATED", {
        idea_ids: insertedIdeas.map((i) => i.id),
        count,
        theme: theme ?? null,
        request_id: requestId
      });

      await client.query("COMMIT");

      res.json({ ok: true, data: { ideas: insertedIdeas, requestId } });
    } catch (err) {
      await client.query("ROLLBACK");
      await safeLogError(sessionId, "Idea generation transaction failed", {
        request_id: requestId,
        error: err
      });
      throw err;
    } finally {
      client.release();
    }
  })
);

app.post(
  "/api/internals/tagcomplete/import-csv",
  asyncHandler(async (req, res) => {
    try {
      await runCsvUpload(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid upload";
      return respondError(res, 400, "Invalid upload", { message });
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      return respondError(res, 400, "File is required");
    }

    const errorsSample: Array<{ row: number; message: string; raw?: unknown }> = [];
    const batch: Array<{ tag: string; type: string | null; count: number | null; aliases: string[] }> = [];
    let totalRows = 0;
    let upserted = 0;

    const pushError = (row: number, message: string, raw?: unknown) => {
      if (errorsSample.length >= TAG_CSV_ERRORS_SAMPLE_LIMIT) return;
      errorsSample.push(raw ? { row, message, raw } : { row, message });
    };

    const flushBatch = async () => {
      if (batch.length === 0) return;
      const values: any[] = [];
      const placeholders = batch.map((item, idx) => {
        const base = idx * 4;
        values.push(item.tag, item.type, item.count, JSON.stringify(item.aliases));
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`;
      });
      try {
        await pool.query(
          `INSERT INTO tag_dictionary_entries (tag, type, count, aliases)
           VALUES ${placeholders.join(", ")}
           ON CONFLICT (tag) DO UPDATE
             SET type = EXCLUDED.type,
                 count = EXCLUDED.count,
                 aliases = EXCLUDED.aliases,
                 updated_at = NOW()`,
          values
        );
        upserted += batch.length;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Database error";
        pushError(totalRows, message);
      } finally {
        batch.length = 0;
      }
    };

    const parser = parse({
      bom: true,
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: true
    });

    try {
      const stream = Readable.from(file.buffer);
      stream.pipe(parser);

      for await (const record of parser) {
        totalRows += 1;
        if (!Array.isArray(record)) {
          pushError(totalRows, "Invalid record");
          continue;
        }
        if (record.length < 1) {
          pushError(totalRows, "Empty row");
          continue;
        }
        const tagRaw = String(record[0] ?? "").trim();
        if (!tagRaw) {
          pushError(totalRows, "tag is required");
          continue;
        }
        const typeRaw = String(record[1] ?? "").trim();
        const countRaw = String(record[2] ?? "").trim();
        const aliasParts = record.length > 3 ? record.slice(3) : [""];
        const aliasesRaw = aliasParts.map((part) => String(part ?? "")).join(",");

        const countValue = Number(countRaw);
        const count = Number.isFinite(countValue) ? Math.trunc(countValue) : null;
        const type = typeRaw.length > 0 ? typeRaw : null;

        const aliases: string[] = [];
        const seen = new Set<string>();
        for (const raw of aliasesRaw.split(",")) {
          const trimmed = raw.trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          aliases.push(trimmed);
        }

        batch.push({ tag: tagRaw, type, count, aliases });
        if (batch.length >= TAG_CSV_BATCH_SIZE) {
          await flushBatch();
        }
      }
      await flushBatch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "CSV parse failed";
      return respondError(res, 400, "CSV parse failed", { message });
    }

    res.json({ ok: true, data: { totalRows, upserted, errorsSample } });
  })
);

app.post(
  "/api/internals/tag-dictionary/import",
  asyncHandler(async (req, res) => {
    try {
      await runTagDictionaryUpload(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid upload";
      return respondError(res, 400, "Invalid upload", { message });
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file?.path) {
      return respondError(res, 400, "File is required");
    }

    const errors: Array<{ row: number; message: string; raw?: unknown }> = [];
    let errorCount = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let rowNumber = 0;

    const pushError = (row: number, message: string, raw?: unknown) => {
      errorCount += 1;
      if (errors.length >= TAG_CSV_ERRORS_SAMPLE_LIMIT) return;
      errors.push(raw ? { row, message, raw } : { row, message });
    };

    const normalizeHeaderKey = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, "_");
    const headerAliases: Record<string, string> = {
      tag: "tag",
      name: "tag",
      tag_name: "tag",
      tag_type: "tag_type",
      type: "tag_type",
      category: "tag_type",
      post_count: "post_count",
      count: "post_count",
      posts: "post_count",
      aliases: "aliases",
      alias: "aliases",
      ja: "ja",
      jp: "ja",
      japanese: "ja"
    };

    const parseAliasesCell = (value: unknown) => {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          try {
            const parsed = JSON.parse(trimmed);
            return normalizeStringList(parsed);
          } catch {
            return normalizeStringList(trimmed.replace(/\|/g, ","));
          }
        }
        return normalizeStringList(trimmed.replace(/\|/g, ","));
      }
      return normalizeStringList(value);
    };

    const dedupeAliases = (aliases: string[]) => {
      const seen = new Set<string>();
      const result: string[] = [];
      for (const alias of aliases) {
        const key = alias.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(alias);
      }
      return result;
    };

    const parseNumberCell = (value: unknown, row: number, field: string) => {
      const raw = String(value ?? "").trim();
      if (!raw) return null;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        pushError(row, `${field} is not a number`, { value: raw });
        return null;
      }
      return Math.trunc(parsed);
    };

    type TagDictionaryItem = {
      row: number;
      tag: string;
      tagType: number | null;
      postCount: number | null;
      aliases: string[];
      ja: string | null;
    };

    const batch: TagDictionaryItem[] = [];

    const upsertOne = async (item: TagDictionaryItem) => {
      const result = await pool.query(
        `INSERT INTO tag_dictionary_entries (tag, tag_type, post_count, aliases, ja, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, NOW(), NOW())
         ON CONFLICT (tag) DO UPDATE
           SET tag_type = EXCLUDED.tag_type,
               post_count = EXCLUDED.post_count,
               aliases = EXCLUDED.aliases,
               ja = EXCLUDED.ja,
               updated_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [item.tag, item.tagType, item.postCount, JSON.stringify(item.aliases), item.ja]
      );
      if (result.rows[0]?.inserted) {
        inserted += 1;
      } else {
        updated += 1;
      }
    };

    const flushBatch = async () => {
      if (batch.length === 0) return;
      const values: any[] = [];
      const placeholders = batch.map((item, idx) => {
        const base = idx * 5;
        values.push(item.tag, item.tagType, item.postCount, JSON.stringify(item.aliases), item.ja);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5})`;
      });
      try {
        const result = await pool.query(
          `INSERT INTO tag_dictionary_entries (tag, tag_type, post_count, aliases, ja, created_at, updated_at)
           VALUES ${placeholders.join(", ")}
           ON CONFLICT (tag) DO UPDATE
             SET tag_type = EXCLUDED.tag_type,
                 post_count = EXCLUDED.post_count,
                 aliases = EXCLUDED.aliases,
                 ja = EXCLUDED.ja,
                 updated_at = NOW()
           RETURNING (xmax = 0) AS inserted`,
          values
        );
        for (const row of result.rows) {
          if (row.inserted) {
            inserted += 1;
          } else {
            updated += 1;
          }
        }
      } catch (err) {
        for (const item of batch) {
          try {
            await upsertOne(item);
          } catch (innerErr) {
            skipped += 1;
            const message = innerErr instanceof Error ? innerErr.message : "Database error";
            pushError(item.row, message, { tag: item.tag });
          }
        }
      } finally {
        batch.length = 0;
      }
    };

    const parser = parse({
      bom: true,
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: true
    });

    let headerMap: Record<string, number> | null = null;
    let headerChecked = false;

    try {
      const stream = fs.createReadStream(file.path);
      stream.pipe(parser);

      for await (const record of parser) {
        rowNumber += 1;
        if (!Array.isArray(record)) {
          skipped += 1;
          pushError(rowNumber, "Invalid record");
          continue;
        }

        if (!headerChecked) {
          const normalized = record.map((value) => normalizeHeaderKey(String(value ?? "")));
          const headerKeys = normalized.filter((key) => key in headerAliases);
          const hasTagKey = headerKeys.some((key) => headerAliases[key] === "tag");
          if (hasTagKey && headerKeys.length >= 2) {
            headerMap = {};
            normalized.forEach((key, idx) => {
              const mapped = headerAliases[key];
              if (mapped && headerMap && headerMap[mapped] === undefined) {
                headerMap[mapped] = idx;
              }
            });
            headerChecked = true;
            continue;
          }
          headerChecked = true;
          headerMap = null;
        }

        const getCell = (key: string, fallbackIndex: number) => {
          if (headerMap) {
            const idx = headerMap[key];
            return idx === undefined ? undefined : record[idx];
          }
          return record[fallbackIndex];
        };

        const tagRaw = String(getCell("tag", 0) ?? "").trim();
        if (!tagRaw) {
          skipped += 1;
          pushError(rowNumber, "tag is required");
          continue;
        }

        const tagType = parseNumberCell(getCell("tag_type", 1), rowNumber, "tag_type");
        const postCount = parseNumberCell(getCell("post_count", 2), rowNumber, "post_count");
        const aliases = dedupeAliases(parseAliasesCell(getCell("aliases", 3)));
        const jaRaw = String(getCell("ja", 4) ?? "").trim();
        const ja = jaRaw ? jaRaw : null;

        batch.push({ row: rowNumber, tag: tagRaw, tagType, postCount, aliases, ja });
        if (batch.length >= TAG_CSV_BATCH_SIZE) {
          await flushBatch();
        }
      }

      await flushBatch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "CSV parse failed";
      return respondError(res, 400, "CSV parse failed", { message });
    } finally {
      try {
        await fs.promises.unlink(file.path);
      } catch {
        // ignore cleanup errors
      }
    }

    res.json({ ok: true, data: { inserted, updated, skipped, errorCount, errors } });
  })
);

app.get(
  "/api/tags/search",
  asyncHandler(async (req, res) => {
    const parsed = tagSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const limit = parsed.data.limit ?? 50;
    const offset = parsed.data.offset ?? 0;
    const queryRaw = parsed.data.query?.trim() ?? "";
    if (queryRaw.length <= 1) {
      return res.json({ ok: true, data: { items: [] } });
    }
    const query = queryRaw.toLowerCase();
    const queryAlt = query.replace(/[\s-]+/g, "_");
    const uniqueTerms = Array.from(new Set([query, queryAlt].filter((term) => term.length > 0)));
    if (uniqueTerms.length === 0) {
      return res.json({ ok: true, data: { items: [] } });
    }

    const exactTerms = uniqueTerms;
    const prefixPatterns = uniqueTerms.map((term) => `${term}%`);
    const containsPatterns = uniqueTerms.map((term) => `%${term}%`);

    const itemsResult = await pool.query(
      `SELECT tag, tag_type, post_count, aliases, ja,
              LEAST(
                CASE
                  WHEN lower(tag) = ANY($1) THEN 0
                  WHEN lower(tag) LIKE ANY($2) THEN 1
                  WHEN lower(tag) LIKE ANY($3) THEN 2
                  ELSE 9
                END,
                COALESCE(
                  (SELECT MIN(
                    CASE
                      WHEN lower(alias) = ANY($1) THEN 0
                      WHEN lower(alias) LIKE ANY($2) THEN 1
                      WHEN lower(alias) LIKE ANY($3) THEN 2
                      ELSE 9
                    END
                  )
                   FROM jsonb_array_elements_text(COALESCE(aliases, '[]'::jsonb)) alias),
                  9
                )
              ) AS rank
       FROM tag_dictionary_entries
       WHERE lower(tag) LIKE ANY($3)
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(COALESCE(aliases, '[]'::jsonb)) alias
            WHERE lower(alias) LIKE ANY($3)
          )
       ORDER BY rank ASC, post_count DESC NULLS LAST, length(tag) ASC, tag ASC
       LIMIT $4
       OFFSET $5`,
      [exactTerms, prefixPatterns, containsPatterns, limit, offset]
    );

    const items = itemsResult.rows.map((row) => ({
      tag: row.tag,
      tagType: row.tag_type,
      postCount: row.post_count,
      aliases: row.aliases ?? [],
      ja: row.ja ?? null
    }));

    res.json({ ok: true, data: { items } });
  })
);

app.get(
  "/api/tags/dictionary",
  asyncHandler(async (req, res) => {
    const parsed = tagQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const limit = parsed.data.limit ?? 50;
    const offset = parsed.data.offset ?? 0;
    const queryRaw = parsed.data.q?.trim() ?? "";
    const query = queryRaw.toLowerCase();
    const queryAlt = query.replace(/[\s-]+/g, "_");
    const uniqueTerms = Array.from(new Set([query, queryAlt].filter((term) => term.length > 0)));

    let itemsResult;
    let totalResult;

    if (uniqueTerms.length === 0) {
      itemsResult = await pool.query(
        `SELECT tag,
                type,
                count,
                aliases,
                tag_type,
                COALESCE(post_count, count) AS post_count,
                ja,
                created_at,
                updated_at
         FROM tag_dictionary_entries
         ORDER BY tag ASC
         LIMIT $1
         OFFSET $2`,
        [limit, offset]
      );
      totalResult = await pool.query(`SELECT COUNT(*)::int AS total FROM tag_dictionary_entries`);
    } else {
      const exactTerms = uniqueTerms;
      const prefixPatterns = uniqueTerms.map((term) => `${term}%`);
      const containsPatterns = uniqueTerms.map((term) => `%${term}%`);
      itemsResult = await pool.query(
        `SELECT tag,
                type,
                count,
                aliases,
                tag_type,
                COALESCE(post_count, count) AS post_count,
                ja,
                created_at,
                updated_at,
                LEAST(
                  CASE
                    WHEN lower(tag) = ANY($1) THEN 0
                    WHEN lower(tag) LIKE ANY($2) THEN 1
                    WHEN lower(tag) LIKE ANY($3) THEN 2
                    ELSE 9
                  END,
                  COALESCE(
                    (SELECT MIN(
                      CASE
                        WHEN lower(alias) = ANY($1) THEN 0
                        WHEN lower(alias) LIKE ANY($2) THEN 1
                        WHEN lower(alias) LIKE ANY($3) THEN 2
                        ELSE 9
                      END
                    )
                     FROM jsonb_array_elements_text(COALESCE(aliases, '[]'::jsonb)) alias),
                    9
                  )
                ) AS rank
         FROM tag_dictionary_entries
         WHERE lower(tag) LIKE ANY($3)
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(COALESCE(aliases, '[]'::jsonb)) alias
              WHERE lower(alias) LIKE ANY($3)
            )
         ORDER BY rank ASC, COALESCE(post_count, count) DESC NULLS LAST, length(tag) ASC, tag ASC
         LIMIT $4
         OFFSET $5`,
        [exactTerms, prefixPatterns, containsPatterns, limit, offset]
      );
      totalResult = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM tag_dictionary_entries
         WHERE lower(tag) LIKE ANY($1)
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(COALESCE(aliases, '[]'::jsonb)) alias
              WHERE lower(alias) LIKE ANY($1)
            )`,
        [containsPatterns]
      );
    }

    res.json({ ok: true, data: { items: itemsResult.rows, total: totalResult.rows[0]?.total ?? 0 } });
  })
);

app.put(
  "/api/tags/dictionary",
  asyncHandler(async (req, res) => {
    const parsed = tagDictionaryUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const tag = parsed.data.tag.trim();
    const type = parsed.data.type?.trim() || null;
    const count = typeof parsed.data.count === "number" ? parsed.data.count : null;
    const aliases = extractStringArray(parsed.data.aliases ?? []);
    const aliasesJson = JSON.stringify(aliases);

    const result = await pool.query(
      `INSERT INTO tag_dictionary_entries (tag, type, count, aliases, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())
       ON CONFLICT (tag) DO UPDATE
         SET type = EXCLUDED.type,
             count = EXCLUDED.count,
             aliases = EXCLUDED.aliases,
             updated_at = NOW()
       RETURNING tag, type, count, aliases, created_at, updated_at`,
      [tag, type, count, aliasesJson]
    );
    res.json({ ok: true, data: { entry: result.rows[0] } });
  })
);

app.delete(
  "/api/tags/dictionary/:tag",
  asyncHandler(async (req, res) => {
    const tag = safeDecodeURIComponent(req.params.tag || "").trim();
    if (!tag) {
      return respondError(res, 400, "Invalid tag");
    }
    const result = await pool.query("DELETE FROM tag_dictionary_entries WHERE lower(tag) = lower($1)", [tag]);
    if (result.rowCount === 0) {
      return respondError(res, 404, "Tag not found");
    }
    res.json({ ok: true, data: { tag } });
  })
);

app.post(
  "/api/tags/dictionary/bulk-upsert",
  asyncHandler(async (req, res) => {
    const parsed = tagDictionaryBulkSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const normalized = parsed.data.items.map((item) => ({
      tag: item.tag.trim(),
      type: item.type?.trim() || null,
      count: typeof item.count === "number" ? item.count : null,
      aliases: extractStringArray(item.aliases ?? [])
    }));
    const dedupedMap = new Map<string, typeof normalized[number]>();
    for (const item of normalized) {
      dedupedMap.set(item.tag.toLowerCase(), item);
    }
    const items = Array.from(dedupedMap.values());
    if (items.length > 1000) {
      return respondError(res, 400, "Too many items");
    }
    const mode = parsed.data.mode ?? "upsert";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (mode === "replace") {
        await client.query("DELETE FROM tag_dictionary_entries");
      }
      const values: any[] = [];
      const placeholders = items.map((item, idx) => {
        const base = idx * 4;
        values.push(item.tag, item.type, item.count, JSON.stringify(item.aliases));
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`;
      });
      await client.query(
        `INSERT INTO tag_dictionary_entries (tag, type, count, aliases)
         VALUES ${placeholders.join(", ")}
         ON CONFLICT (tag) DO UPDATE
           SET type = EXCLUDED.type,
               count = EXCLUDED.count,
               aliases = EXCLUDED.aliases,
               updated_at = NOW()`,
        values
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true, data: { count: items.length, mode } });
  })
);

app.get(
  "/api/tags/translations",
  asyncHandler(async (req, res) => {
    const parsed = tagQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const limit = parsed.data.limit ?? 50;
    const offset = parsed.data.offset ?? 0;
    const query = parsed.data.q?.trim();
    const params: any[] = [];
    let where = "";
    if (query) {
      params.push(`%${query}%`);
      where = "WHERE tag ILIKE $1 OR ja ILIKE $1";
    }
    const limitParam = params.length + 1;
    params.push(limit);
    const offsetParam = params.length + 1;
    params.push(offset);

    const itemsResult = await pool.query(
      `SELECT tag, ja, source, seen_count, created_at, updated_at
       FROM tag_translations
       ${where}
       ORDER BY tag ASC
       LIMIT $${limitParam}
       OFFSET $${offsetParam}`,
      params
    );
    const totalResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM tag_translations ${where}`,
      query ? [params[0]] : []
    );

    res.json({ ok: true, data: { items: itemsResult.rows, total: totalResult.rows[0]?.total ?? 0 } });
  })
);

app.post(
  "/api/tags/translations/lookup",
  asyncHandler(async (req, res) => {
    const parsed = tagTranslationLookupSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const tags = extractStringArray(parsed.data.tags);
    if (tags.length === 0) {
      return respondError(res, 400, "tags is required");
    }
    if (tags.length > 200) {
      return respondError(res, 400, "Too many tags");
    }
    const lookup = uniqStrings(tags.map((tag) => tag.toLowerCase()));
    const result = await pool.query(
      "SELECT tag, ja FROM tag_translations WHERE lower(tag) = ANY($1)",
      [lookup]
    );
    const translations: Record<string, string> = {};
    for (const row of result.rows) {
      translations[row.tag] = row.ja;
    }
    res.json({ ok: true, data: { translations } });
  })
);

app.put(
  "/api/tags/translations",
  asyncHandler(async (req, res) => {
    const parsed = tagTranslationUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const tag = parsed.data.tag.trim();
    const ja = parsed.data.ja.trim();
    const source = parsed.data.source?.trim() || "ollama";

    const result = await pool.query(
      `INSERT INTO tag_translations (tag, ja, source, seen_count, created_at, updated_at)
       VALUES ($1, $2, $3, 0, NOW(), NOW())
       ON CONFLICT (tag) DO UPDATE
         SET ja = EXCLUDED.ja,
             source = EXCLUDED.source,
             updated_at = NOW()
       RETURNING tag, ja, source, seen_count, created_at, updated_at`,
      [tag, ja, source]
    );
    res.json({ ok: true, data: { entry: result.rows[0] } });
  })
);

app.post(
  "/api/tags/translations/bulk-upsert",
  asyncHandler(async (req, res) => {
    const parsed = tagTranslationBulkSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const normalized = parsed.data.items.map((item) => ({
      tag: item.tag.trim(),
      ja: item.ja.trim(),
      source: item.source?.trim() || "ollama"
    }));
    const dedupedMap = new Map<string, typeof normalized[number]>();
    for (const item of normalized) {
      dedupedMap.set(item.tag.toLowerCase(), item);
    }
    const items = Array.from(dedupedMap.values());
    if (items.length > 500) {
      return respondError(res, 400, "Too many items");
    }
    const values: any[] = [];
    const placeholders = items.map((item, idx) => {
      const base = idx * 3;
      values.push(item.tag, item.ja, item.source);
      return `($${base + 1}, $${base + 2}, $${base + 3})`;
    });
    await pool.query(
      `INSERT INTO tag_translations (tag, ja, source)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (tag) DO UPDATE
         SET ja = EXCLUDED.ja,
             source = EXCLUDED.source,
             updated_at = NOW()`,
      values
    );
    res.json({ ok: true, data: { count: items.length } });
  })
);

app.delete(
  "/api/tags/translations/:tag",
  asyncHandler(async (req, res) => {
    const tag = safeDecodeURIComponent(req.params.tag || "").trim();
    if (!tag) {
      return respondError(res, 400, "Invalid tag");
    }
    const result = await pool.query("DELETE FROM tag_translations WHERE lower(tag) = lower($1)", [tag]);
    if (result.rowCount === 0) {
      return respondError(res, 404, "Tag not found");
    }
    res.json({ ok: true, data: { tag } });
  })
);

app.get(
  "/api/prompt/tag-groups",
  asyncHandler(async (_req, res) => {
    const result = await pool.query(
      `SELECT id, label, sort_order, filter, created_at, updated_at
       FROM prompt_tag_groups
       ORDER BY sort_order ASC, id ASC`
    );
    res.json({ ok: true, data: { groups: result.rows } });
  })
);

app.post(
  "/api/prompt/tag-groups",
  asyncHandler(async (req, res) => {
    const parsed = promptTagGroupCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const label = parsed.data.label.trim();
    const sortOrder = parsed.data.sortOrder ?? 0;
    const filter = parsed.data.filter ? JSON.stringify(parsed.data.filter) : null;

    const result = await pool.query(
      `INSERT INTO prompt_tag_groups (label, sort_order, filter, created_at, updated_at)
       VALUES ($1, $2, COALESCE($3::jsonb, '{"tag_type":[4]}'::jsonb), NOW(), NOW())
       RETURNING id, label, sort_order, filter, created_at, updated_at`,
      [label, sortOrder, filter]
    );
    res.status(201).json({ ok: true, data: { group: result.rows[0] } });
  })
);

app.patch(
  "/api/prompt/tag-groups/:id",
  asyncHandler(async (req, res) => {
    const groupId = z.coerce.number().int().min(1).safeParse(req.params.id);
    if (!groupId.success) {
      return respondError(res, 400, "Invalid group id");
    }
    const parsed = promptTagGroupUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;
    if (parsed.data.label !== undefined) {
      updates.push(`label = $${idx++}`);
      values.push(parsed.data.label.trim());
    }
    if (parsed.data.sortOrder !== undefined) {
      updates.push(`sort_order = $${idx++}`);
      values.push(parsed.data.sortOrder);
    }
    if (parsed.data.filter !== undefined) {
      updates.push(`filter = $${idx++}::jsonb`);
      values.push(JSON.stringify(parsed.data.filter));
    }
    updates.push("updated_at = NOW()");
    values.push(groupId.data);

    const result = await pool.query(
      `UPDATE prompt_tag_groups SET ${updates.join(", ")} WHERE id = $${idx}
       RETURNING id, label, sort_order, filter, created_at, updated_at`,
      values
    );
    if (result.rowCount === 0) {
      return respondError(res, 404, "Group not found");
    }
    res.json({ ok: true, data: { group: result.rows[0] } });
  })
);

app.delete(
  "/api/prompt/tag-groups/:id",
  asyncHandler(async (req, res) => {
    const groupId = z.coerce.number().int().min(1).safeParse(req.params.id);
    if (!groupId.success) {
      return respondError(res, 400, "Invalid group id");
    }
    const result = await pool.query("DELETE FROM prompt_tag_groups WHERE id = $1 RETURNING id", [groupId.data]);
    if (result.rowCount === 0) {
      return respondError(res, 404, "Group not found");
    }
    res.json({ ok: true, data: { id: result.rows[0].id } });
  })
);

app.put(
  "/api/prompt/tag-group-overrides/:tag",
  asyncHandler(async (req, res) => {
    const tagRaw = safeDecodeURIComponent(req.params.tag || "").trim();
    if (!tagRaw) {
      return respondError(res, 400, "Invalid tag");
    }
    const parsed = promptTagGroupOverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    if (parsed.data.groupId === null) {
      await pool.query("DELETE FROM prompt_tag_group_overrides WHERE lower(tag) = lower($1)", [tagRaw]);
      return res.json({ ok: true, data: { tag: tagRaw, groupId: null } });
    }

    const tagResult = await pool.query("SELECT tag FROM tag_dictionary_entries WHERE lower(tag) = lower($1)", [tagRaw]);
    if (tagResult.rowCount === 0) {
      return respondError(res, 404, "Tag not found");
    }
    const groupResult = await pool.query("SELECT id FROM prompt_tag_groups WHERE id = $1", [parsed.data.groupId]);
    if (groupResult.rowCount === 0) {
      return respondError(res, 404, "Group not found");
    }

    const result = await pool.query(
      `INSERT INTO prompt_tag_group_overrides (tag, group_id, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (tag) DO UPDATE
         SET group_id = EXCLUDED.group_id,
             updated_at = NOW()
       RETURNING tag, group_id, updated_at`,
      [tagResult.rows[0].tag, parsed.data.groupId]
    );
    res.json({ ok: true, data: { override: result.rows[0] } });
  })
);

app.get(
  "/api/prompt/conflicts",
  asyncHandler(async (_req, res) => {
    const result = await pool.query(
      `SELECT id, a, b, severity, message, created_at
       FROM prompt_conflict_rules
       ORDER BY id ASC`
    );
    res.json({ ok: true, data: { conflicts: result.rows } });
  })
);

app.post(
  "/api/prompt/conflicts",
  asyncHandler(async (req, res) => {
    const parsed = promptConflictCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const severity = parsed.data.severity ?? "warn";
    const message = parsed.data.message?.trim() || null;

    const result = await pool.query(
      `INSERT INTO prompt_conflict_rules (a, b, severity, message, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, a, b, severity, message, created_at`,
      [parsed.data.a.trim(), parsed.data.b.trim(), severity, message]
    );
    res.status(201).json({ ok: true, data: { conflict: result.rows[0] } });
  })
);

app.delete(
  "/api/prompt/conflicts/:id",
  asyncHandler(async (req, res) => {
    const conflictId = z.coerce.number().int().min(1).safeParse(req.params.id);
    if (!conflictId.success) {
      return respondError(res, 400, "Invalid conflict id");
    }
    const result = await pool.query("DELETE FROM prompt_conflict_rules WHERE id = $1 RETURNING id", [conflictId.data]);
    if (result.rowCount === 0) {
      return respondError(res, 404, "Conflict not found");
    }
    res.json({ ok: true, data: { id: result.rows[0].id } });
  })
);

app.get(
  "/api/prompt/templates",
  asyncHandler(async (_req, res) => {
    const result = await pool.query(
      `SELECT id, name, target, tokens, sort_order, created_at, updated_at
       FROM prompt_templates
       ORDER BY sort_order ASC, id ASC`
    );
    res.json({ ok: true, data: { templates: result.rows } });
  })
);

app.post(
  "/api/prompt/templates",
  asyncHandler(async (req, res) => {
    const parsed = promptTemplateCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }
    const sortOrder = parsed.data.sortOrder ?? 0;
    const tokensJson = JSON.stringify(parsed.data.tokens);

    const result = await pool.query(
      `INSERT INTO prompt_templates (name, target, tokens, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, NOW(), NOW())
       RETURNING id, name, target, tokens, sort_order, created_at, updated_at`,
      [parsed.data.name.trim(), parsed.data.target, tokensJson, sortOrder]
    );
    res.status(201).json({ ok: true, data: { template: result.rows[0] } });
  })
);

app.patch(
  "/api/prompt/templates/:id",
  asyncHandler(async (req, res) => {
    const templateId = z.coerce.number().int().min(1).safeParse(req.params.id);
    if (!templateId.success) {
      return respondError(res, 400, "Invalid template id");
    }
    const parsed = promptTemplateUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;
    if (parsed.data.name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(parsed.data.name.trim());
    }
    if (parsed.data.target !== undefined) {
      updates.push(`target = $${idx++}`);
      values.push(parsed.data.target);
    }
    if (parsed.data.tokens !== undefined) {
      updates.push(`tokens = $${idx++}::jsonb`);
      values.push(JSON.stringify(parsed.data.tokens));
    }
    if (parsed.data.sortOrder !== undefined) {
      updates.push(`sort_order = $${idx++}`);
      values.push(parsed.data.sortOrder);
    }
    updates.push("updated_at = NOW()");
    values.push(templateId.data);

    const result = await pool.query(
      `UPDATE prompt_templates SET ${updates.join(", ")} WHERE id = $${idx}
       RETURNING id, name, target, tokens, sort_order, created_at, updated_at`,
      values
    );
    if (result.rowCount === 0) {
      return respondError(res, 404, "Template not found");
    }
    res.json({ ok: true, data: { template: result.rows[0] } });
  })
);

app.delete(
  "/api/prompt/templates/:id",
  asyncHandler(async (req, res) => {
    const templateId = z.coerce.number().int().min(1).safeParse(req.params.id);
    if (!templateId.success) {
      return respondError(res, 400, "Invalid template id");
    }
    const result = await pool.query("DELETE FROM prompt_templates WHERE id = $1 RETURNING id", [templateId.data]);
    if (result.rowCount === 0) {
      return respondError(res, 404, "Template not found");
    }
    res.json({ ok: true, data: { id: result.rows[0].id } });
  })
);

// Whisper routes
app.get(
  "/api/whisper/models",
  asyncHandler(async (_req, res) => {
    const models = await whisperService.listModels();
    res.json({ ok: true, data: { models, defaultLanguage: whisperService.getDefaultLanguage() } });
  })
);

app.post(
  "/api/whisper/jobs",
  asyncHandler(async (req, res) => {
    try {
      await runWhisperUpload(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid upload";
      return respondError(res, 400, "Invalid upload", { message });
    }

    const parsed = whisperJobCreateSchema.safeParse({
      modelFile: (req.body as any)?.modelFile,
      language: (req.body as any)?.language
    });
    if (!parsed.success) {
      return respondError(res, 400, "Invalid request", parsed.error.flatten());
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      return respondError(res, 400, "File is required");
    }

    const models = await whisperService.listModels();
    const allowedModels = new Set(models.map((model: { file: string }) => model.file));
    if (!allowedModels.has(parsed.data.modelFile)) {
      return respondError(res, 400, "modelFile is not allowed");
    }

    const language = parsed.data.language ?? whisperService.getDefaultLanguage();

    const job = await whisperService.createJob({
      buffer: file.buffer,
      originalName: file.originalname || "audio",
      modelFile: parsed.data.modelFile,
      language
    });

    res.status(201).json({ ok: true, data: { jobId: job.id, job } });
  })
);

app.get(
  "/api/whisper/jobs",
  asyncHandler(async (_req, res) => {
    const jobs = await whisperService.listJobs();
    res.json({ ok: true, data: { jobs } });
  })
);

app.get(
  "/api/whisper/jobs/:id",
  asyncHandler(async (req, res) => {
    const jobId = z.string().uuid().safeParse(req.params.id);
    if (!jobId.success) {
      return respondError(res, 400, "Invalid job id");
    }
    const job = await whisperService.getJob(jobId.data, { includeTranscript: true });
    if (!job) {
      return respondError(res, 404, "Job not found");
    }
    res.json({ ok: true, data: { job } });
  })
);

app.post(
  "/api/whisper/jobs/:id/cancel",
  asyncHandler(async (req, res) => {
    const jobId = z.string().uuid().safeParse(req.params.id);
    if (!jobId.success) {
      return respondError(res, 400, "Invalid job id");
    }
    const result = await whisperService.cancelJob(jobId.data);
    if ("error" in result) {
      return respondError(res, 400, result.error ?? "Cancel failed");
    }
    res.json({ ok: true, data: { job: result.job } });
  })
);

app.get(
  "/api/whisper/jobs/:id/output",
  asyncHandler(async (req, res) => {
    const jobId = z.string().uuid().safeParse(req.params.id);
    if (!jobId.success) {
      return respondError(res, 400, "Invalid job id");
    }
    const result = await whisperService.readOutput(jobId.data);
    if ("error" in result) {
      const status = "code" in result && typeof result.code === "number" ? result.code : 404;
      return respondError(res, status, result.error ?? "Output not available");
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"whisper_${jobId.data}.txt\"`);
    res.send(result.text);
  })
);

app.delete(
  "/api/whisper/jobs/:id",
  asyncHandler(async (req, res) => {
    const jobId = z.string().uuid().safeParse(req.params.id);
    if (!jobId.success) {
      return respondError(res, 400, "Invalid job id");
    }
    const result = await whisperService.deleteJob(jobId.data);
    if ("error" in result) {
      const status = "code" in result && typeof result.code === "number" ? result.code : 400;
      return respondError(res, status, result.error ?? "Delete failed");
    }
    res.json({ ok: true, data: { deleted: true, id: jobId.data } });
  })
);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ ok: false, error: { message: err instanceof Error ? err.message : "Internal Server Error" } });
});
};
