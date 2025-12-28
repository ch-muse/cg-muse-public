import { Pool } from "pg";
import { ensureMuseDataDirs, warnIfMuseDataDirInsideRepo } from "../services/storage/storagePaths.js";
import { whisperService } from "../services/whisperService.js";

export type AppContext = {
  port: number;
  databaseUrl: string;
  pool: Pool;
};

export const createContext = (): AppContext => {
  const port = Number(process.env.PORT) || 4010;
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  warnIfMuseDataDirInsideRepo();
  try {
    ensureMuseDataDirs();
  } catch (err) {
    console.error("Failed to ensure MUSE_DATA_DIR", err);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  whisperService.init(pool);

  return { port, databaseUrl, pool };
};
