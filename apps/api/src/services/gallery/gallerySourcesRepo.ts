import type { Pool, PoolClient } from "pg";

type Queryable = Pool | PoolClient;

export type GallerySourceRow = {
  id: string;
  name: string;
  root_path: string;
  enabled: boolean;
  recursive: boolean;
  include_glob: string | null;
  last_scan_at: string | null;
  last_error: string | null;
  created_at: string;
};

export type GallerySourceInput = {
  name: string;
  rootPath: string;
  enabled: boolean;
  recursive: boolean;
  includeGlob?: string | null;
};

export type GallerySourceUpdate = Partial<GallerySourceInput>;

export const listGallerySources = async (db: Queryable): Promise<GallerySourceRow[]> => {
  const result = await db.query<GallerySourceRow>("SELECT * FROM gallery_sources ORDER BY created_at DESC");
  return result.rows;
};

export const getGallerySourceById = async (db: Queryable, id: string): Promise<GallerySourceRow | null> => {
  const result = await db.query<GallerySourceRow>("SELECT * FROM gallery_sources WHERE id = $1", [id]);
  if (result.rowCount === 0) return null;
  return result.rows[0];
};

export const createGallerySource = async (db: Queryable, input: GallerySourceInput): Promise<GallerySourceRow> => {
  const result = await db.query<GallerySourceRow>(
    `INSERT INTO gallery_sources (name, root_path, enabled, recursive, include_glob)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.name, input.rootPath, input.enabled, input.recursive, input.includeGlob ?? null]
  );
  return result.rows[0];
};

export const updateGallerySource = async (
  db: Queryable,
  id: string,
  updates: GallerySourceUpdate
): Promise<GallerySourceRow | null> => {
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${idx++}`);
    values.push(updates.name);
  }
  if (updates.rootPath !== undefined) {
    fields.push(`root_path = $${idx++}`);
    values.push(updates.rootPath);
  }
  if (updates.enabled !== undefined) {
    fields.push(`enabled = $${idx++}`);
    values.push(updates.enabled);
  }
  if (updates.recursive !== undefined) {
    fields.push(`recursive = $${idx++}`);
    values.push(updates.recursive);
  }
  if (updates.includeGlob !== undefined) {
    fields.push(`include_glob = $${idx++}`);
    values.push(updates.includeGlob ?? null);
  }

  if (fields.length === 0) {
    return getGallerySourceById(db, id);
  }

  values.push(id);
  const result = await db.query<GallerySourceRow>(
    `UPDATE gallery_sources SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (result.rowCount === 0) return null;
  return result.rows[0];
};

export const deleteGallerySource = async (db: Queryable, id: string): Promise<boolean> => {
  const result = await db.query("DELETE FROM gallery_sources WHERE id = $1", [id]);
  return result.rowCount > 0;
};

export const updateGallerySourceScanState = async (
  db: Queryable,
  id: string,
  payload: { lastScanAt: string | null; lastError: string | null }
): Promise<void> => {
  await db.query("UPDATE gallery_sources SET last_scan_at = $2, last_error = $3 WHERE id = $1", [
    id,
    payload.lastScanAt,
    payload.lastError
  ]);
};
