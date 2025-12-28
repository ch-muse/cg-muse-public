import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

type ComfyConfig = {
  listen: string;
  port: number;
  dir: string;
  python: string;
  url: string;
  extraArgs: string[];
  extraArgsPresent: boolean;
};

export type ComfyStatus = {
  running: boolean;
  managed: boolean;
  pid: number | null;
  url: string;
  config: {
    listen: string;
    port: number;
    dir: string;
    python: string;
    extraArgsPresent: boolean;
  };
  lastError: string | null;
  timestamps: {
    lastProbeAt: string | null;
    lastStartAt: string | null;
  };
};

export type ComfyStartResult = {
  status: ComfyStatus;
  started: boolean;
  message?: string;
  error?: string;
};

export type ComfyStopResult = {
  status: ComfyStatus;
  stopped: boolean;
  error?: string;
};

type ComfyState = {
  managed: boolean;
  child: ChildProcess | null;
  pid: number | null;
  lastStartAt: string | null;
  lastProbeAt: string | null;
  lastProbeMs: number | null;
  lastProbeResult: boolean | null;
  lastError: string | null;
};

const state: ComfyState = {
  managed: false,
  child: null,
  pid: null,
  lastStartAt: null,
  lastProbeAt: null,
  lastProbeMs: null,
  lastProbeResult: null,
  lastError: null
};

const parseExtraArgs = (raw?: string | null) => {
  if (!raw || !raw.trim()) return [];
  const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return tokens.map((token) => token.replace(/^"(.*)"$/, "$1"));
};

const getConfig = (): ComfyConfig => {
  const defaultDir = process.platform === "win32" ? "C:\\AI\\ComfyUI" : "";
  const dir = (process.env.COMFYUI_DIR || defaultDir).trim();
  const listen = (process.env.COMFYUI_LISTEN || "127.0.0.1").trim() || "127.0.0.1";
  const portRaw = Number(process.env.COMFYUI_PORT);
  const port = Number.isFinite(portRaw) ? portRaw : 8188;
  const extraArgs = parseExtraArgs(process.env.COMFYUI_EXTRA_ARGS);
  const defaultPython = dir ? path.join(dir, "venv", "Scripts", "python.exe") : "";
  const pythonEnv = (process.env.COMFYUI_PYTHON || "").trim();
  const python = pythonEnv || (defaultPython && existsSync(defaultPython) ? defaultPython : "python");
  const url = `http://${listen}:${port}/`;

  return {
    listen,
    port,
    dir,
    python,
    url,
    extraArgs,
    extraArgsPresent: extraArgs.length > 0
  };
};

const buildStatus = (running: boolean, config = getConfig()): ComfyStatus => ({
  running,
  managed: state.managed,
  pid: state.pid,
  url: config.url,
  config: {
    listen: config.listen,
    port: config.port,
    dir: config.dir,
    python: config.python,
    extraArgsPresent: config.extraArgsPresent
  },
  lastError: state.lastError,
  timestamps: {
    lastProbeAt: state.lastProbeAt,
    lastStartAt: state.lastStartAt
  }
});

const probe = async (force = false): Promise<boolean> => {
  const now = Date.now();
  if (!force && state.lastProbeMs && state.lastProbeResult !== null && now - state.lastProbeMs < 1000) {
    return state.lastProbeResult;
  }

  const { url } = getConfig();
  let running = false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    running = res.ok;
  } catch {
    running = false;
  }

  state.lastProbeMs = now;
  state.lastProbeAt = new Date(now).toISOString();
  state.lastProbeResult = running;
  return running;
};

const waitForReady = async (maxAttempts = 60, intervalMs = 1000) => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const running = await probe(true);
    if (running) return true;
    await sleep(intervalMs);
  }
  return false;
};

const terminateProcess = async (child: ChildProcess, pid: number): Promise<boolean> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };

    const timer = setTimeout(() => {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
        killer.on("close", () => finish(true));
        killer.on("error", () => finish(false));
      } else {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        setTimeout(() => finish(false), 300);
      }
    }, 700);

    child.once("exit", () => {
      clearTimeout(timer);
      finish(true);
    });

    try {
      child.kill("SIGINT");
    } catch {
      // ignore
    }
  });

const handleChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
  state.child = null;
  state.pid = null;
  state.managed = false;
  if (code && code !== 0) {
    state.lastError = `ComfyUI exited with code ${code}`;
  } else if (signal) {
    state.lastError = `ComfyUI exited via signal ${signal}`;
  } else {
    state.lastError = null;
  }
};

const getStatus = async (forceProbe = false): Promise<ComfyStatus> => {
  const running = await probe(forceProbe);
  return buildStatus(running);
};

const start = async (): Promise<ComfyStartResult> => {
  const config = getConfig();
  if (!config.dir) {
    return {
      status: buildStatus(false, config),
      started: false,
      error: "COMFYUI_DIR is required to start ComfyUI (set environment variable or use start-dev.cmd)"
    };
  }
  if (!existsSync(config.dir)) {
    return {
      status: buildStatus(false, config),
      started: false,
      error: `COMFYUI_DIR not found: ${config.dir}`
    };
  }

  const alreadyRunning = await probe(true);
  if (alreadyRunning) {
    const status = buildStatus(true, config);
    return { status, started: false, message: "ComfyUI already running" };
  }

  let child: ChildProcess;
  try {
    child = spawn(config.python, ["main.py", "--listen", config.listen, "--port", String(config.port), ...config.extraArgs], {
      cwd: config.dir,
      stdio: "ignore"
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to spawn ComfyUI";
    state.lastError = message;
    return { status: buildStatus(false, config), started: false, error: message };
  }

  state.managed = true;
  state.child = child;
  state.pid = child.pid ?? null;
  state.lastStartAt = new Date().toISOString();
  state.lastError = null;

  child.on("exit", handleChildExit);
  child.on("error", (err) => {
    state.lastError = err instanceof Error ? err.message : String(err);
  });

  const ready = await waitForReady();
  if (!ready && !state.lastError) {
    state.lastError = "ComfyUI did not become ready within timeout";
  }

  const running = ready || (await probe(true));
  return { status: buildStatus(running, config), started: ready };
};

const stop = async (): Promise<ComfyStopResult> => {
  if (!state.managed || !state.child || !state.pid) {
    const status = await getStatus(true);
    return { status, stopped: false, error: "ComfyUI is not managed by API" };
  }

  const child = state.child;
  const pid = state.pid;

  const success = await terminateProcess(child, pid);

  state.child = null;
  state.pid = null;
  state.managed = false;

  if (!success) {
    state.lastError = state.lastError || "Failed to stop ComfyUI process";
  }

  const status = await getStatus(true);
  return { status, stopped: success };
};

export const comfyService = {
  getStatus,
  start,
  stop,
  getConfig
};
