import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type WhisperPaths = {
  root: string;
  inputsDir: string;
  outputsDir: string;
  tempDir: string;
};

type WorkshopPaths = {
  root: string;
  recipeThumbsDir: string;
  loraThumbsDir: string;
};

type ComfyPaths = {
  root: string;
  initImagesDir: string;
  controlImagesDir: string;
  taggerInputsDir: string;
};

type ComfyWorkflowPaths = {
  text2i: string;
  image2i: string;
  tagger: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resolveDefaultMuseDataDir = () => {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "cg-muse");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "cg-muse");
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "cg-muse");
};

const resolveMuseDataDir = () => {
  const envDir = (process.env.MUSE_DATA_DIR || "").trim();
  const base = envDir || resolveDefaultMuseDataDir();
  return path.resolve(base);
};

const normalizeForCompare = (value: string) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const isPathInside = (target: string, base: string) => {
  const resolvedTarget = normalizeForCompare(target);
  const resolvedBase = normalizeForCompare(base);
  if (resolvedTarget === resolvedBase) return true;
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : `${resolvedBase}${path.sep}`;
  return resolvedTarget.startsWith(baseWithSep);
};

const findRepoRoot = () => {
  let current = path.resolve(__dirname);
  for (let i = 0; i < 8; i += 1) {
    const gitDir = path.join(current, ".git");
    const workspaceFile = path.join(current, "pnpm-workspace.yaml");
    if (fs.existsSync(gitDir) || fs.existsSync(workspaceFile)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "";
};

const MUSE_DATA_DIR = resolveMuseDataDir();

const WHISPER_ROOT = path.join(MUSE_DATA_DIR, "whisper");
const WHISPER_INPUTS_DIR = path.join(WHISPER_ROOT, "inputs");
const WHISPER_OUTPUTS_DIR = path.join(WHISPER_ROOT, "outputs");
const WHISPER_TEMP_DIR = path.join(WHISPER_ROOT, "temp");

const WORKSHOP_ROOT = path.join(MUSE_DATA_DIR, "workshop");
const WORKSHOP_RECIPE_THUMBS_DIR = path.join(WORKSHOP_ROOT, "recipe_thumbs");
const WORKSHOP_LORA_THUMBS_DIR = path.join(WORKSHOP_ROOT, "lora_thumbs");

const COMFY_ROOT = path.join(MUSE_DATA_DIR, "comfy");
const COMFY_INIT_IMAGES_DIR = path.join(COMFY_ROOT, "init_images");
const COMFY_CONTROL_IMAGES_DIR = path.join(COMFY_ROOT, "control_images");
const COMFY_TAGGER_INPUTS_DIR = path.join(COMFY_ROOT, "tagger_inputs");

const CACHE_ROOT = path.join(MUSE_DATA_DIR, "cache");

const API_DATA_ROOT = path.resolve(__dirname, "../../..", "data");
const COMFY_WORKFLOWS_DIR = path.join(API_DATA_ROOT, "comfy", "workflows");
const COMFY_WORKFLOW_TEXT2I_PATH = path.join(COMFY_WORKFLOWS_DIR, "base_text2i.json");
const COMFY_WORKFLOW_IMAGE2I_PATH = path.join(COMFY_WORKFLOWS_DIR, "base_image2i.json");
const COMFY_WORKFLOW_TAGGER_PATH = path.join(COMFY_WORKFLOWS_DIR, "tagger_only.json");

const ensureDir = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
};

const ensureWhisperDirs = () => {
  [WHISPER_ROOT, WHISPER_INPUTS_DIR, WHISPER_OUTPUTS_DIR, WHISPER_TEMP_DIR].forEach(ensureDir);
};

const ensureWorkshopDirs = () => {
  [WORKSHOP_ROOT, WORKSHOP_RECIPE_THUMBS_DIR, WORKSHOP_LORA_THUMBS_DIR].forEach(ensureDir);
};

const ensureComfyDirs = () => {
  [COMFY_ROOT, COMFY_INIT_IMAGES_DIR, COMFY_CONTROL_IMAGES_DIR, COMFY_TAGGER_INPUTS_DIR].forEach(ensureDir);
};

const ensureCacheDirs = () => {
  [CACHE_ROOT].forEach(ensureDir);
};

const ensureMuseDataDirs = () => {
  ensureWhisperDirs();
  ensureWorkshopDirs();
  ensureComfyDirs();
  ensureCacheDirs();
};

const resolveMediaPath = (key: string) => {
  if (!key) return null;
  const target = path.resolve(WORKSHOP_ROOT, key);
  if (!isPathInside(target, WORKSHOP_ROOT)) return null;
  return target;
};

const warnIfMuseDataDirInsideRepo = () => {
  const repoRoot = findRepoRoot();
  if (!repoRoot) return;
  if (!isPathInside(MUSE_DATA_DIR, repoRoot)) return;
  console.warn(
    `MUSE_DATA_DIR is inside the repository (${MUSE_DATA_DIR}). Consider moving it outside (${repoRoot}).`
  );
};

const getWhisperPaths = (): WhisperPaths => ({
  root: WHISPER_ROOT,
  inputsDir: WHISPER_INPUTS_DIR,
  outputsDir: WHISPER_OUTPUTS_DIR,
  tempDir: WHISPER_TEMP_DIR
});

const getWorkshopPaths = (): WorkshopPaths => ({
  root: WORKSHOP_ROOT,
  recipeThumbsDir: WORKSHOP_RECIPE_THUMBS_DIR,
  loraThumbsDir: WORKSHOP_LORA_THUMBS_DIR
});

const getComfyPaths = (): ComfyPaths => ({
  root: COMFY_ROOT,
  initImagesDir: COMFY_INIT_IMAGES_DIR,
  controlImagesDir: COMFY_CONTROL_IMAGES_DIR,
  taggerInputsDir: COMFY_TAGGER_INPUTS_DIR
});

const getComfyWorkflowPaths = (): ComfyWorkflowPaths => ({
  text2i: COMFY_WORKFLOW_TEXT2I_PATH,
  image2i: COMFY_WORKFLOW_IMAGE2I_PATH,
  tagger: COMFY_WORKFLOW_TAGGER_PATH
});

export {
  MUSE_DATA_DIR,
  ensureMuseDataDirs,
  ensureWhisperDirs,
  getWhisperPaths,
  getWorkshopPaths,
  getComfyPaths,
  getComfyWorkflowPaths,
  resolveMediaPath,
  warnIfMuseDataDirInsideRepo,
  isPathInside
};
