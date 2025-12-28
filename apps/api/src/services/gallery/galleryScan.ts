import fs from "node:fs";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import {
  getGalleryFolderItemMeta,
  upsertGalleryFolderItems,
  type GalleryFolderMeta
} from "./galleryRepo.js";
import type { GallerySourceRow } from "./gallerySourcesRepo.js";
import { updateGallerySourceScanState } from "./gallerySourcesRepo.js";
import { extractImageMetadata } from "./metadataExtract.js";

type Queryable = Pool | PoolClient;

export type GalleryScanResult = {
  imported: number;
  skipped: number;
  errors: number;
};

const scanLocks = new Set<string>();

const normalizeRelPath = (rootPath: string, absolutePath: string) =>
  path.relative(rootPath, absolutePath).replace(/\\/g, "/");

const parseIncludeGlob = (value?: string | null) => {
  if (!value) return null;
  const raw = value
    .split(/[;,]/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (raw.length === 0) return null;
  const set = new Set<string>();
  for (const item of raw) {
    if (!item) continue;
    const normalized = item.startsWith("*.") ? item.slice(1) : item.startsWith(".") ? item : `.${item}`;
    set.add(normalized.toLowerCase());
  }
  return set;
};

const shouldInclude = (fileName: string, include: Set<string> | null) => {
  if (!include || include.size === 0) return true;
  const ext = path.extname(fileName).toLowerCase();
  if (!ext) return false;
  return include.has(ext);
};

const buildFileMeta = (stat: fs.Stats): GalleryFolderMeta => ({
  file: {
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs)
  }
});

const fileMetaMatches = (meta: GalleryFolderMeta | null, stat: fs.Stats) => {
  if (!meta || !meta.file) return false;
  const size = meta.file.size;
  const mtimeMs = meta.file.mtimeMs;
  if (typeof size !== "number" || typeof mtimeMs !== "number") return false;
  return size === stat.size && mtimeMs === Math.trunc(stat.mtimeMs);
};

const toStringOrNull = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

const toNumberOrNull = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toStringArrayOrNull = (value: unknown) => {
  if (!Array.isArray(value)) return null;
  const filtered = value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return filtered.length > 0 ? filtered : null;
};

export const scanGallerySource = async (
  db: Queryable,
  source: GallerySourceRow
): Promise<{ ok: true; result: GalleryScanResult } | { ok: false; error: string }> => {
  if (scanLocks.has(source.id)) {
    return { ok: false, error: "scan_in_progress" };
  }

  scanLocks.add(source.id);
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let lastError: string | null = null;
  const now = new Date().toISOString();
  const include = parseIncludeGlob(source.include_glob);
  const rootPath = path.resolve(source.root_path);

  try {
    const rootStat = await fs.promises.stat(rootPath);
    if (!rootStat.isDirectory()) {
      throw new Error("root_not_directory");
    }

    const queue: string[] = [rootPath];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;

      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch (err) {
        errors += 1;
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (source.recursive) {
            queue.push(fullPath);
          }
          continue;
        }
        if (!entry.isFile()) continue;
        if (!shouldInclude(entry.name, include)) {
          skipped += 1;
          continue;
        }

        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(fullPath);
        } catch (err) {
          errors += 1;
          lastError = err instanceof Error ? err.message : String(err);
          continue;
        }
        const relPath = normalizeRelPath(rootPath, fullPath);
        if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
          errors += 1;
          lastError = "invalid_rel_path";
          continue;
        }

        try {
          const existing = await getGalleryFolderItemMeta(db, source.id, relPath);
          if (existing && fileMetaMatches(existing.meta, stat)) {
            skipped += 1;
            continue;
          }

          let metaExtracted: Record<string, unknown> = {};
          let parsedExtracted: Record<string, unknown> = {};
          let needsReview = true;
          const ext = path.extname(entry.name).toLowerCase();
          if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") {
            try {
              const buffer = await fs.promises.readFile(fullPath);
              const extracted = extractImageMetadata(buffer);
              parsedExtracted = extracted.parsed;
              metaExtracted = {
                raw: extracted.raw,
                parsed: extracted.parsed,
                parseErrors: extracted.parseErrors,
                source: extracted.source
              };
              needsReview = extracted.source === "none";
            } catch (err) {
              errors += 1;
              lastError = err instanceof Error ? err.message : String(err);
            }
          } else {
            metaExtracted = {
              raw: {},
              parsed: {},
              parseErrors: ["unknown_format"],
              source: "none"
            };
          }

          const ckptName = toStringOrNull(parsedExtracted.ckpt);
          const loraNames = toStringArrayOrNull(parsedExtracted.loras);
          const positive = toStringOrNull(parsedExtracted.positive);
          const negative = toStringOrNull(parsedExtracted.negative);
          const width = toNumberOrNull(parsedExtracted.width);
          const height = toNumberOrNull(parsedExtracted.height);

          await upsertGalleryFolderItems(db, [
            {
              sourceId: source.id,
              relPath,
              filename: entry.name,
              width,
              height,
              ckptName,
              loraNames,
              positive,
              negative,
              createdAt: new Date(stat.mtimeMs).toISOString(),
              meta: buildFileMeta(stat),
              metaExtracted,
              needsReview
            }
          ]);
          imported += 1;
        } catch (err) {
          errors += 1;
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (err) {
    errors += 1;
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    await updateGallerySourceScanState(db, source.id, {
      lastScanAt: now,
      lastError
    });
    scanLocks.delete(source.id);
  }

  return { ok: true, result: { imported, skipped, errors } };
};
