import type { Pool, PoolClient } from "pg";

type Queryable = Pool | PoolClient;

export type GalleryItemRow = {
  id: string;
  source_type: string;
  source_id: string | null;
  comfy_run_id: string | null;
  rel_path: string | null;
  prompt_id: string | null;
  filename: string;
  subfolder: string | null;
  file_type: string | null;
  width: number | null;
  height: number | null;
  ckpt_name: string | null;
  lora_names: string[] | null;
  positive: string | null;
  negative: string | null;
  manual_ckpt_name: string | null;
  manual_lora_names: string[] | null;
  manual_positive: string | null;
  manual_negative: string | null;
  manual_width: number | null;
  manual_height: number | null;
  manual_tags: string[] | null;
  manual_notes: string | null;
  created_at: string | Date;
  favorited: boolean;
  meta: unknown;
  meta_extracted: unknown;
  meta_overrides: unknown;
  needs_review: boolean;
};

export type GalleryCursor = {
  createdAt: string;
  id: string;
};

export type GalleryFilters = {
  ckpt?: string;
  loras?: string[];
  width?: number;
  height?: number;
  dateFrom?: string;
  dateTo?: string;
  q?: string;
  favorited?: boolean;
};

export type GalleryListInput = {
  limit: number;
  cursor?: GalleryCursor | null;
  filters?: GalleryFilters;
};

const normalizeTimestamp = (value: string | Date) => {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString();
};

export const buildGalleryCursor = (item: { created_at: string | Date; id: string }) =>
  `${normalizeTimestamp(item.created_at)}|${item.id}`;

export const listGalleryItems = async (
  db: Queryable,
  input: GalleryListInput
): Promise<{ items: GalleryItemRow[]; nextCursor: string | null }> => {
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 200);
  const filters = input.filters ?? {};
  const clauses: string[] = [];
  const values: any[] = [];

  if (filters.ckpt) {
    values.push(filters.ckpt);
    clauses.push(`COALESCE(manual_ckpt_name, ckpt_name) = $${values.length}`);
  }

  if (filters.loras && filters.loras.length > 0) {
    values.push(filters.loras);
    clauses.push(`COALESCE(manual_lora_names, lora_names) && $${values.length}`);
  }

  if (typeof filters.width === "number") {
    values.push(filters.width);
    clauses.push(`COALESCE(manual_width, width) = $${values.length}`);
  }

  if (typeof filters.height === "number") {
    values.push(filters.height);
    clauses.push(`COALESCE(manual_height, height) = $${values.length}`);
  }

  if (filters.dateFrom) {
    values.push(filters.dateFrom);
    clauses.push(`created_at >= $${values.length}`);
  }

  if (filters.dateTo) {
    values.push(filters.dateTo);
    clauses.push(`created_at <= $${values.length}`);
  }

  if (filters.q) {
    values.push(`%${filters.q}%`);
    clauses.push(
      `(COALESCE(manual_positive, positive) ILIKE $${values.length} OR COALESCE(manual_negative, negative) ILIKE $${values.length})`
    );
  }

  if (typeof filters.favorited === "boolean") {
    values.push(filters.favorited);
    clauses.push(`favorited = $${values.length}`);
  }

  if (input.cursor) {
    const cursorCreatedParam = values.length + 1;
    const cursorIdParam = values.length + 2;
    values.push(input.cursor.createdAt, input.cursor.id);
    clauses.push(
      `(created_at < $${cursorCreatedParam} OR (created_at = $${cursorCreatedParam} AND id < $${cursorIdParam}))`
    );
  }

  values.push(limit + 1);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const query = `
    SELECT *
    FROM gallery_items
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT $${values.length}
  `;

  const result = await db.query<GalleryItemRow>(query, values);
  const items = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;
  const nextCursor = hasMore && items.length > 0 ? buildGalleryCursor(items[items.length - 1]) : null;

  return { items, nextCursor };
};

export const getGalleryItemById = async (db: Queryable, id: string): Promise<GalleryItemRow | null> => {
  const result = await db.query<GalleryItemRow>("SELECT * FROM gallery_items WHERE id = $1", [id]);
  if (result.rowCount === 0) return null;
  return result.rows[0];
};

export const updateGalleryFavorite = async (
  db: Queryable,
  id: string,
  favorite?: boolean
): Promise<GalleryItemRow | null> => {
  const result =
    typeof favorite === "boolean"
      ? await db.query<GalleryItemRow>(
          "UPDATE gallery_items SET favorited = $2 WHERE id = $1 RETURNING *",
          [id, favorite]
        )
      : await db.query<GalleryItemRow>("UPDATE gallery_items SET favorited = NOT favorited WHERE id = $1 RETURNING *", [
          id
        ]);
  if (result.rowCount === 0) return null;
  return result.rows[0];
};

export type GalleryUpsertItem = {
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

export type GalleryFolderMeta = {
  file?: {
    size?: number;
    mtimeMs?: number;
  };
};

export const getGalleryFolderItemMeta = async (
  db: Queryable,
  sourceId: string,
  relPath: string
): Promise<{ id: string; meta: GalleryFolderMeta } | null> => {
  const result = await db.query<{ id: string; meta: GalleryFolderMeta }>(
    `SELECT id, meta
     FROM gallery_items
     WHERE source_type = 'folder' AND source_id = $1 AND rel_path = $2
     LIMIT 1`,
    [sourceId, relPath]
  );
  if (result.rowCount === 0) return null;
  return result.rows[0];
};

export const upsertGalleryItems = async (db: Queryable, items: GalleryUpsertItem[]) => {
  if (items.length === 0) return;

  const columns = [
    "source_type",
    "comfy_run_id",
    "prompt_id",
    "filename",
    "subfolder",
    "file_type",
    "width",
    "height",
    "ckpt_name",
    "lora_names",
    "positive",
    "negative",
    "created_at",
    "meta",
    "meta_extracted",
    "needs_review"
  ];
  const values: any[] = [];
  const placeholders = items.map((item, idx) => {
    const base = idx * columns.length;
    values.push(
      item.sourceType,
      item.comfyRunId,
      item.promptId,
      item.filename,
      item.subfolder,
      item.fileType,
      item.width,
      item.height,
      item.ckptName,
      item.loraNames,
      item.positive,
      item.negative,
      item.createdAt ?? new Date().toISOString(),
      item.meta,
      item.metaExtracted,
      item.needsReview
    );
    return `(${columns.map((_col, colIdx) => `$${base + colIdx + 1}`).join(", ")})`;
  });

  const query = `
    INSERT INTO gallery_items (${columns.join(", ")})
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (source_type, comfy_run_id, filename, COALESCE(subfolder, ''), COALESCE(file_type, ''))
    DO UPDATE SET
      prompt_id = COALESCE(EXCLUDED.prompt_id, gallery_items.prompt_id),
      width = EXCLUDED.width,
      height = EXCLUDED.height,
      ckpt_name = EXCLUDED.ckpt_name,
      lora_names = EXCLUDED.lora_names,
      positive = EXCLUDED.positive,
      negative = EXCLUDED.negative,
      meta = EXCLUDED.meta,
      meta_extracted = EXCLUDED.meta_extracted,
      needs_review = EXCLUDED.needs_review
  `;

  await db.query(query, values);
};

export type GalleryFolderUpsertItem = {
  sourceId: string;
  relPath: string;
  filename: string;
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

export const upsertGalleryFolderItems = async (db: Queryable, items: GalleryFolderUpsertItem[]) => {
  if (items.length === 0) return;

  const columns = [
    "source_type",
    "source_id",
    "rel_path",
    "filename",
    "width",
    "height",
    "ckpt_name",
    "lora_names",
    "positive",
    "negative",
    "created_at",
    "meta",
    "meta_extracted",
    "needs_review"
  ];
  const values: any[] = [];
  const placeholders = items.map((item, idx) => {
    const base = idx * columns.length;
    values.push(
      "folder",
      item.sourceId,
      item.relPath,
      item.filename,
      item.width,
      item.height,
      item.ckptName,
      item.loraNames,
      item.positive,
      item.negative,
      item.createdAt ?? new Date().toISOString(),
      item.meta,
      item.metaExtracted,
      item.needsReview
    );
    return `(${columns.map((_col, colIdx) => `$${base + colIdx + 1}`).join(", ")})`;
  });

  const query = `
    INSERT INTO gallery_items (${columns.join(", ")})
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (source_type, source_id, rel_path)
    DO UPDATE SET
      filename = EXCLUDED.filename,
      width = EXCLUDED.width,
      height = EXCLUDED.height,
      ckpt_name = EXCLUDED.ckpt_name,
      lora_names = EXCLUDED.lora_names,
      positive = EXCLUDED.positive,
      negative = EXCLUDED.negative,
      created_at = EXCLUDED.created_at,
      meta = EXCLUDED.meta,
      meta_extracted = EXCLUDED.meta_extracted,
      needs_review = EXCLUDED.needs_review
  `;

  await db.query(query, values);
};

export type GalleryManualUpdate = {
  manualCkptName?: string | null;
  manualLoraNames?: string[] | null;
  manualPositive?: string | null;
  manualNegative?: string | null;
  manualWidth?: number | null;
  manualHeight?: number | null;
  manualTags?: string[] | null;
  manualNotes?: string | null;
  metaOverrides?: Record<string, unknown>;
};

export const updateGalleryManualFields = async (
  db: Queryable,
  id: string,
  update: GalleryManualUpdate
): Promise<GalleryItemRow | null> => {
  const updates: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (update.manualCkptName !== undefined) {
    updates.push(`manual_ckpt_name = $${idx++}`);
    values.push(update.manualCkptName);
  }
  if (update.manualLoraNames !== undefined) {
    updates.push(`manual_lora_names = $${idx++}`);
    values.push(update.manualLoraNames);
  }
  if (update.manualPositive !== undefined) {
    updates.push(`manual_positive = $${idx++}`);
    values.push(update.manualPositive);
  }
  if (update.manualNegative !== undefined) {
    updates.push(`manual_negative = $${idx++}`);
    values.push(update.manualNegative);
  }
  if (update.manualWidth !== undefined) {
    updates.push(`manual_width = $${idx++}`);
    values.push(update.manualWidth);
  }
  if (update.manualHeight !== undefined) {
    updates.push(`manual_height = $${idx++}`);
    values.push(update.manualHeight);
  }
  if (update.manualTags !== undefined) {
    updates.push(`manual_tags = $${idx++}`);
    values.push(update.manualTags);
  }
  if (update.manualNotes !== undefined) {
    updates.push(`manual_notes = $${idx++}`);
    values.push(update.manualNotes);
  }
  if (update.metaOverrides !== undefined) {
    updates.push(`meta_overrides = $${idx++}`);
    values.push(update.metaOverrides);
  }

  if (updates.length === 0) {
    const existing = await db.query<GalleryItemRow>("SELECT * FROM gallery_items WHERE id = $1", [id]);
    if (existing.rowCount === 0) return null;
    return existing.rows[0];
  }

  values.push(id);
  const result = await db.query<GalleryItemRow>(
    `UPDATE gallery_items SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (result.rowCount === 0) return null;
  return result.rows[0];
};

export type GalleryExtractedUpdate = {
  ckptName?: string | null;
  loraNames?: string[] | null;
  positive?: string | null;
  negative?: string | null;
  width?: number | null;
  height?: number | null;
  metaExtracted?: Record<string, unknown>;
  needsReview?: boolean;
};

export const updateGalleryExtractedFields = async (
  db: Queryable,
  id: string,
  update: GalleryExtractedUpdate
): Promise<GalleryItemRow | null> => {
  const updates: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (update.ckptName !== undefined) {
    updates.push(`ckpt_name = $${idx++}`);
    values.push(update.ckptName);
  }
  if (update.loraNames !== undefined) {
    updates.push(`lora_names = $${idx++}`);
    values.push(update.loraNames);
  }
  if (update.positive !== undefined) {
    updates.push(`positive = $${idx++}`);
    values.push(update.positive);
  }
  if (update.negative !== undefined) {
    updates.push(`negative = $${idx++}`);
    values.push(update.negative);
  }
  if (update.width !== undefined) {
    updates.push(`width = $${idx++}`);
    values.push(update.width);
  }
  if (update.height !== undefined) {
    updates.push(`height = $${idx++}`);
    values.push(update.height);
  }
  if (update.metaExtracted !== undefined) {
    updates.push(`meta_extracted = $${idx++}`);
    values.push(update.metaExtracted);
  }
  if (update.needsReview !== undefined) {
    updates.push(`needs_review = $${idx++}`);
    values.push(update.needsReview);
  }

  if (updates.length === 0) {
    const existing = await db.query<GalleryItemRow>("SELECT * FROM gallery_items WHERE id = $1", [id]);
    if (existing.rowCount === 0) return null;
    return existing.rows[0];
  }

  values.push(id);
  const result = await db.query<GalleryItemRow>(
    `UPDATE gallery_items SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (result.rowCount === 0) return null;
  return result.rows[0];
};

export const deleteGalleryItem = async (db: Queryable, id: string): Promise<GalleryItemRow | null> => {
  const result = await db.query<GalleryItemRow>("DELETE FROM gallery_items WHERE id = $1 RETURNING *", [id]);
  if (result.rowCount === 0) return null;
  return result.rows[0];
};
