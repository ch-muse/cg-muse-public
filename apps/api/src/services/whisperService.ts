import { randomUUID } from "crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { ensureWhisperDirs, getWhisperPaths, isPathInside } from "./storage/storagePaths.js";

type WhisperJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

type WhisperJobRow = {
  id: string;
  status: WhisperJobStatus;
  model_file: string;
  language: string | null;
  input_original_name: string;
  input_path: string;
  preprocessed_wav_path: string | null;
  output_text_path: string | null;
  stdout_tail: string | null;
  stderr_tail: string | null;
  pid: number | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

export type WhisperJobView = {
  id: string;
  status: WhisperJobStatus;
  modelFile: string;
  language: string;
  inputOriginalName: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  errorMessage?: string | null;
  downloadUrl?: string | null;
  warnings?: string[];
  transcriptText?: string | null;
  outputTextPath?: string | null;
};

type WhisperConfig = {
  binDir: string;
  modelsDir: string;
  exeName: string;
  ffmpegPath: string;
  defaultLanguage: string;
  concurrency: number;
};

const MAX_LOG_LENGTH = 8000;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const LANG_PRESET = ["auto", "ja", "en", "zh", "ko", "fr", "de", "es", "it", "pt", "ru"] as const;
const { root: WHISPER_ROOT, inputsDir: INPUT_DIR, outputsDir: OUTPUT_DIR, tempDir: TEMP_DIR } = getWhisperPaths();

const exists = (p: string) => {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const trimTail = (text: string, limit = MAX_LOG_LENGTH) => {
  if (!text) return "";
  return text.length > limit ? text.slice(-limit) : text;
};

const sanitizeName = (value: string) => {
  const base = path.basename(value || "input");
  return base.replace(/[^\w.\-]+/g, "_");
};

const toLanguageValue = (value?: string | null) => {
  if (!value) return "auto";
  const normalized = value.trim().toLowerCase();
  return LANG_PRESET.includes(normalized as (typeof LANG_PRESET)[number]) ? normalized : "auto";
};

const parseConfig = (): WhisperConfig => {
  const rawConcurrency = Number(process.env.WHISPER_CONCURRENCY);
  const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency > 0 ? Math.floor(rawConcurrency) : 1;
  const defaultLanguage = toLanguageValue(process.env.WHISPER_DEFAULT_LANGUAGE || "auto");
  const binDir = (process.env.WHISPER_BIN_DIR || "C:\\AI\\whisper.cpp\\build\\bin").trim();
  const modelsDir = (process.env.WHISPER_MODELS_DIR || "C:\\AI\\whisper.cpp\\models").trim();
  const exeName = (process.env.WHISPER_EXE || "whisper-cli.exe").trim();
  const ffmpegPath = (process.env.FFMPEG_PATH || "ffmpeg").trim();
  return {
    binDir,
    modelsDir,
    exeName,
    ffmpegPath,
    defaultLanguage,
    concurrency
  };
};

const ensureDirs = () => {
  ensureWhisperDirs();
};

const truncateBuffer = (buf: Buffer, limit = MAX_TEXT_BYTES) => {
  if (buf.byteLength <= limit) return buf;
  return buf.subarray(buf.byteLength - limit);
};

const tailCollector = () => {
  let value = "";
  return {
    append: (chunk: Buffer) => {
      value = trimTail(value + chunk.toString("utf8"));
    },
    get: () => value
  };
};

const terminateProcess = (child: ChildProcess, pid: number | null) =>
  new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once("exit", () => finish());
    if (process.platform === "win32" && pid) {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
      killer.on("close", () => finish());
      killer.on("error", () => finish());
    } else {
      try {
        child.kill("SIGINT");
      } catch {
        // ignore
      }
      setTimeout(() => finish(), 500);
    }
  });

const isInsideWhisperRoot = (target: string) => isPathInside(target, WHISPER_ROOT);

const deleteFileSafe = async (target?: string | null) => {
  if (!target) return;
  if (!isInsideWhisperRoot(target)) return;
  try {
    await fs.promises.unlink(target);
  } catch (err: any) {
    if (err && typeof err === "object" && "code" in err && (err as any).code === "ENOENT") return;
    console.error("Failed to delete file", target, err);
  }
};

const detectExecutable = (config: WhisperConfig) => {
  const candidate = path.isAbsolute(config.exeName) ? config.exeName : path.join(config.binDir, config.exeName);
  if (exists(candidate)) return candidate;
  const fallback = path.join(config.binDir, "whisper-cli");
  if (exists(fallback)) return fallback;
  return candidate;
};

const detectOutputSupport = async (exePath: string, cwd: string) => {
  try {
    const { stdout, stderr } = await runProcess(exePath, ["--help"], { cwd });
    const text = `${stdout}${stderr}`.toLowerCase();
    return text.includes("-otxt") || text.includes("--output-txt") || text.includes("-of");
  } catch {
    return false;
  }
};

const runProcess = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number | null; stdout: string; stderr: string; pid: number | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, shell: false });
    const out = tailCollector();
    const err = tailCollector();
    child.stdout?.on("data", (chunk) => out.append(chunk));
    child.stderr?.on("data", (chunk) => err.append(chunk));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      resolve({ code, stdout: out.get(), stderr: err.get(), pid: child.pid ?? null });
    });
  });

class WhisperService {
  private pool: Pool | null = null;
  private config: WhisperConfig = parseConfig();
  private running = new Map<string, ChildProcess>();
  private queue: string[] = [];
  private active = 0;
  private outputSupportChecked = false;
  private supportsOutputTxt = false;
  private cancelled = new Set<string>();

  init(pool: Pool) {
    this.pool = pool;
    ensureDirs();
    this.resetRunningJobs().catch((err) => {
      console.error("Failed to reset running whisper jobs", err);
    });
  }

  getDefaultLanguage() {
    return this.config.defaultLanguage;
  }

  getLanguagesPreset() {
    return [...LANG_PRESET];
  }

  async listModels() {
    try {
      const entries = await fs.promises.readdir(this.config.modelsDir, { withFileTypes: true });
      const models = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.toLowerCase().endsWith(".bin")) continue;
        const fullPath = path.join(this.config.modelsDir, entry.name);
        let sizeBytes: number | undefined;
        try {
          const stat = await fs.promises.stat(fullPath);
          sizeBytes = stat.size;
        } catch {
          sizeBytes = undefined;
        }
        models.push({ file: entry.name, sizeBytes });
      }
      models.sort((a, b) => a.file.localeCompare(b.file));
      return models;
    } catch (err) {
      console.error("Failed to list whisper models", err);
      return [];
    }
  }

  async createJob(params: { buffer: Buffer; originalName: string; modelFile: string; language?: string | null }) {
    if (!this.pool) throw new Error("Whisper service not initialized");
    const language = toLanguageValue(params.language ?? this.config.defaultLanguage);
    const jobId = randomUUID();
    const safeName = sanitizeName(params.originalName || "audio");
    const inputPath = path.join(INPUT_DIR, `${jobId}_${safeName}`);
    await fs.promises.writeFile(inputPath, params.buffer);

    const storedLanguage = language === "auto" ? null : language;
    const nowInsert = `
      INSERT INTO whisper_jobs (id, status, model_file, language, input_original_name, input_path, created_at, updated_at)
      VALUES ($1, 'queued', $2, $3, $4, $5, NOW(), NOW())
      RETURNING *
    `;
    const result = await this.pool.query(nowInsert, [jobId, params.modelFile, storedLanguage, safeName, inputPath]);
    const row = result.rows[0] as WhisperJobRow;
    this.queue.push(jobId);
    this.processQueue().catch((err) => console.error("Failed to process whisper queue", err));
    return this.toView(row, { includeTranscript: false });
  }

  async listJobs(limit = 50) {
    if (!this.pool) throw new Error("Whisper service not initialized");
    const result = await this.pool.query("SELECT * FROM whisper_jobs ORDER BY created_at DESC LIMIT $1", [limit]);
    return result.rows.map((row: WhisperJobRow) => this.toView(row, { includeTranscript: false }));
  }

  async getJob(id: string, opts?: { includeTranscript?: boolean }) {
    if (!this.pool) throw new Error("Whisper service not initialized");
    const result = await this.pool.query("SELECT * FROM whisper_jobs WHERE id = $1", [id]);
    if (result.rowCount === 0) return null;
    const row = result.rows[0] as WhisperJobRow;
    return this.toView(row, { includeTranscript: opts?.includeTranscript ?? true });
  }

  async cancelJob(id: string) {
    if (!this.pool) throw new Error("Whisper service not initialized");
    const existing = await this.pool.query("SELECT * FROM whisper_jobs WHERE id = $1", [id]);
    if (existing.rowCount === 0) return { error: "Job not found" as const };
    const row = existing.rows[0] as WhisperJobRow;
    if (row.status !== "running") {
      return { error: "Job is not running" as const };
    }
    const child = this.running.get(id);
    this.cancelled.add(id);
    if (child) {
      await terminateProcess(child, row.pid);
    }
    await this.pool.query(
      "UPDATE whisper_jobs SET status = 'cancelled', finished_at = NOW(), updated_at = NOW(), error_message = $2 WHERE id = $1",
      [id, row.error_message ?? "Cancelled"]
    );
    this.running.delete(id);
    return { job: await this.getJob(id) };
  }

  async readOutput(id: string) {
    const job = await this.getJob(id, { includeTranscript: false });
    if (!job) return { error: "Job not found" as const, code: 404 };
    if (!job.downloadUrl || !job.outputTextPath) return { error: "Output not ready" as const, code: 404 };
    if (!exists(job.outputTextPath)) return { error: "Output not found" as const, code: 404 };
    const buf = truncateBuffer(fs.readFileSync(job.outputTextPath));
    return { text: buf.toString("utf8"), path: job.outputTextPath };
  }

  async deleteJob(id: string) {
    if (!this.pool) throw new Error("Whisper service not initialized");
    const existing = await this.pool.query("SELECT * FROM whisper_jobs WHERE id = $1", [id]);
    if (existing.rowCount === 0) return { error: "Job not found" as const };
    const row = existing.rows[0] as WhisperJobRow;
    if (row.status === "running" || row.status === "queued") {
      return { error: "Job is running. Cancel it before deleting." as const, code: 409 };
    }

    await deleteFileSafe(row.input_path);
    await deleteFileSafe(row.preprocessed_wav_path);
    await deleteFileSafe(row.output_text_path);
    await this.pool.query("DELETE FROM whisper_jobs WHERE id = $1", [id]);
    return { deleted: true as const };
  }

  private async resetRunningJobs() {
    if (!this.pool) return;
    await this.pool.query(
      "UPDATE whisper_jobs SET status = 'failed', error_message = 'Interrupted (server restarted)', finished_at = NOW(), updated_at = NOW() WHERE status = 'running'"
    );
  }

  private toView(row: WhisperJobRow, opts: { includeTranscript: boolean }): WhisperJobView {
    const warnings: string[] = [];
    const language = toLanguageValue(row.language);
    if (row.model_file.toLowerCase().includes(".en.bin") && language !== "en") {
      warnings.push("English-only model with non-en language may degrade accuracy.");
    }
    const hasOutput = row.output_text_path && exists(row.output_text_path);
    const downloadUrl = hasOutput ? `/api/whisper/jobs/${row.id}/output` : null;
    const base: WhisperJobView = {
      id: row.id,
      status: row.status,
      modelFile: row.model_file,
      language,
      inputOriginalName: row.input_original_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      stdoutTail: row.stdout_tail,
      stderrTail: row.stderr_tail,
      errorMessage: row.error_message,
      downloadUrl,
      outputTextPath: hasOutput ? row.output_text_path : null,
      warnings: warnings.length > 0 ? warnings : undefined
    };

    if (warnings.length > 0) {
      const note = warnings.join(" ");
      if (base.stderrTail) {
        base.stderrTail = `${base.stderrTail}\n${note}`.slice(-MAX_LOG_LENGTH);
      } else {
        base.stderrTail = note;
      }
    }

    if (!opts.includeTranscript) {
      return base;
    }
    if (row.output_text_path && exists(row.output_text_path)) {
      try {
        const buf = truncateBuffer(fs.readFileSync(row.output_text_path));
        return { ...base, transcriptText: buf.toString("utf8") };
      } catch {
        return { ...base, transcriptText: null };
      }
    }
    return { ...base, transcriptText: null };
  }

  private async processQueue() {
    if (!this.pool) return;
    while (this.active < this.config.concurrency && this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) break;
      this.active += 1;
      this.runJob(jobId)
        .catch((err) => {
          console.error("Whisper job failed", err);
        })
        .finally(() => {
          this.active = Math.max(0, this.active - 1);
          this.processQueue().catch((err) => console.error("Whisper queue error", err));
        });
    }
  }

  private async runJob(id: string) {
    if (!this.pool) return;
    const result = await this.pool.query("SELECT * FROM whisper_jobs WHERE id = $1", [id]);
    if (result.rowCount === 0) return;
    const row = result.rows[0] as WhisperJobRow;
    if (row.status !== "queued") return;

    const exePath = detectExecutable(this.config);
    const modelPath = path.join(this.config.modelsDir, row.model_file);
    const wavPath = path.join(TEMP_DIR, `${row.id}.wav`);
    const outputBase = path.join(OUTPUT_DIR, row.id);
    const expectedOutputPath = `${outputBase}.txt`;
    const tempOutputPath = `${wavPath}.txt`;

    if (!exists(modelPath)) {
      await this.markFailed(id, `Model not found: ${row.model_file}`);
      return;
    }

    if (!exists(exePath)) {
      await this.markFailed(id, `Whisper executable not found: ${exePath}`);
      return;
    }

    await this.pool.query(
      "UPDATE whisper_jobs SET status = 'running', started_at = NOW(), updated_at = NOW(), stderr_tail = NULL, stdout_tail = NULL, pid = NULL WHERE id = $1",
      [id]
    );

    // ffmpeg preprocess
    try {
      const ffmpegArgs = ["-y", "-nostdin", "-i", row.input_path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath];
      const { code, stderr } = await runProcess(this.config.ffmpegPath, ffmpegArgs, { cwd: WHISPER_ROOT });
      if (code !== 0) {
        await this.markFailed(id, "ffmpeg failed", { stderr });
        return;
      }
      await this.pool.query(
        "UPDATE whisper_jobs SET preprocessed_wav_path = $2, stderr_tail = $3, updated_at = NOW() WHERE id = $1",
        [id, wavPath, trimTail(stderr)]
      );
    } catch (err) {
      await this.markFailed(id, err instanceof Error ? err.message : "ffmpeg error");
      return;
    }

    // detect output support once
    if (!this.outputSupportChecked) {
      this.supportsOutputTxt = await detectOutputSupport(exePath, this.config.binDir);
      this.outputSupportChecked = true;
    }

    const args = ["-m", modelPath, "-f", wavPath];
    const language = toLanguageValue(row.language);
    if (language !== "auto") {
      args.push("-l", language);
    }
    if (this.supportsOutputTxt) {
      args.push("-otxt", expectedOutputPath, "-of", outputBase);
    }

    let child: ChildProcess | null = null;
    const stdoutCollector = tailCollector();
    const stderrCollector = tailCollector();

    try {
      child = spawn(exePath, args, { cwd: this.config.binDir, shell: false });
      if (child.pid) {
        await this.pool.query("UPDATE whisper_jobs SET pid = $2, updated_at = NOW() WHERE id = $1", [id, child.pid]);
      }
    } catch (err) {
      await this.markFailed(id, err instanceof Error ? err.message : "Failed to spawn whisper");
      return;
    }

    this.running.set(id, child);
    child.stdout?.on("data", (chunk) => stdoutCollector.append(chunk));
    child.stderr?.on("data", (chunk) => stderrCollector.append(chunk));

    const exitCode: number | null = await new Promise((resolve) => {
      child?.once("close", (code) => resolve(code));
      child?.once("error", () => resolve(1));
    });

    this.running.delete(id);

    if (this.cancelled.has(id)) {
      this.cancelled.delete(id);
      return;
    }

    if (exitCode !== 0) {
      await this.markFailed(id, `whisper exited with code ${exitCode}`, {
        stdout: stdoutCollector.get(),
        stderr: stderrCollector.get()
      });
      return;
    }

    const stdoutText = stdoutCollector.get();
    const stderrText = stderrCollector.get();

    let transcript = "";
    let finalOutputPath: string | null = null;

    const ensureOutputBuffer = async (): Promise<Buffer> => {
      if (exists(expectedOutputPath)) {
        const buf = truncateBuffer(fs.readFileSync(expectedOutputPath));
        finalOutputPath = expectedOutputPath;
        return buf;
      }
      if (exists(tempOutputPath)) {
        const buf = truncateBuffer(fs.readFileSync(tempOutputPath));
        await fs.promises.copyFile(tempOutputPath, expectedOutputPath);
        finalOutputPath = expectedOutputPath;
        return buf;
      }
      const buf = truncateBuffer(Buffer.from(stdoutText));
      try {
        await fs.promises.writeFile(expectedOutputPath, buf);
        finalOutputPath = expectedOutputPath;
      } catch {
        finalOutputPath = null;
      }
      return buf;
    };

    try {
      const buf = await ensureOutputBuffer();
      transcript = buf.toString("utf8");
    } catch (err) {
      await this.markFailed(id, err instanceof Error ? err.message : "Failed to prepare output text", {
        stdout: stdoutText,
        stderr: stderrText
      });
      return;
    }

    await this.pool.query(
      `UPDATE whisper_jobs
       SET status = 'succeeded',
           output_text_path = $2,
           stdout_tail = $3,
           stderr_tail = $4,
           finished_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [id, finalOutputPath, trimTail(stdoutText), trimTail(stderrText)]
    );
  }

  private async markFailed(id: string, message: string, tails?: { stdout?: string; stderr?: string }) {
    if (!this.pool) return;
    await this.pool.query(
      `UPDATE whisper_jobs
       SET status = 'failed',
           error_message = $2,
           stdout_tail = COALESCE($3, stdout_tail),
           stderr_tail = COALESCE($4, stderr_tail),
           finished_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [id, message, tails?.stdout ? trimTail(tails.stdout) : null, tails?.stderr ? trimTail(tails.stderr) : null]
    );
  }
}

export const whisperService = new WhisperService();
export const WHISPER_LANGUAGES = LANG_PRESET;
