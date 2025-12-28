#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const isWin = process.platform === "win32";
const childProcs = [];
let shuttingDown = false;

const flags = parseFlags(process.argv.slice(2));

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

main().catch((err) => {
  log(`[orchestrator] error: ${err?.message || err}`);
  shutdown(1);
});

async function main() {
  log(
    `[orchestrator] start (docker=${
      flags.startDocker ? "on" : "off"
    }, comfy=${flags.startComfy ? "on" : "off"})`,
  );
  log(
    `[orchestrator] ComfyUI autostart: ${flags.startComfy ? "ON" : "OFF (use --comfy to enable)"}`
  );

  if (flags.startDocker) {
    const dockerExit = await runOnce(
      "[orchestrator]",
      dockerCmd(["compose", "up", "-d"]),
    );
    if (dockerExit !== 0) {
      throw new Error(`docker compose up failed (exit code ${dockerExit})`);
    }
  } else {
    log("[orchestrator] skip docker compose (flag --no-docker)");
  }

  await runDbMigrations();

  spawnService("[api]", pnpmCmd(["-C", "apps/api", "dev"]));
  spawnService("[web]", pnpmCmd(["-C", "apps/web", "dev"]));

  if (flags.startComfy) {
    await startComfy();
  } else {
    log("[orchestrator] ComfyUI not requested (use --comfy to enable)");
  }

  log("[orchestrator] all services launched. Ctrl+C to stop.");
}

function parseFlags(argv) {
  let startComfy = false;
  let startDocker = true;

  for (const arg of argv) {
    if (arg === "--comfy") {
      startComfy = true;
    } else if (arg === "--no-comfy") {
      startComfy = false;
    } else if (arg === "--no-docker") {
      startDocker = false;
    } else {
      log(`[orchestrator] unknown flag ignored: ${arg}`);
    }
  }

  return { startComfy: Boolean(startComfy), startDocker };
}

function pnpmCmd(args) {
  return isWin
    ? { cmd: "cmd.exe", args: ["/c", "pnpm", ...args] }
    : { cmd: "pnpm", args };
}

function dockerCmd(args) {
  return isWin
    ? { cmd: "cmd.exe", args: ["/c", "docker", ...args] }
    : { cmd: "docker", args };
}

function logPrefixed(prefix, text) {
  console.log(`${prefix} ${text}`);
}

function log(message) {
  console.log(message);
}

async function runOnce(prefix, { cmd, args, options = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    pipeOutput(child, prefix);

    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve(code ?? 0));
  });
}

async function runDbMigrations() {
  const maxAttempts = 30;
  const delayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`[orchestrator] db:migrate attempt ${attempt}/${maxAttempts}`);
    const exitCode = await runOnce("[db]", pnpmCmd(["-C", "apps/api", "db:migrate"]));

    if (exitCode === 0) {
      log("[orchestrator] db:migrate succeeded");
      return;
    }

    if (attempt === maxAttempts) {
      throw new Error("db:migrate did not succeed after retries");
    }

    log(`[orchestrator] db:migrate failed (code ${exitCode}). retry in 2s...`);
    await sleep(delayMs);
  }
}

function spawnService(prefix, { cmd, args, options = {} }) {
  log(`${prefix} starting: ${cmd} ${args.join(" ")}`);

  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  childProcs.push({ prefix, child });
  pipeOutput(child, prefix);

  const onExit = (code, signal) => {
    log(
      `${prefix} exited (code=${code ?? 0}${
        signal ? `, signal=${signal}` : ""
      })`,
    );

    if (!shuttingDown && code && code !== 0) {
      log("[orchestrator] stopping other services because one exited with error");
      shutdown(1);
    }
  };

  child.on("exit", onExit);
  child.on("error", (err) => {
    log(`${prefix} error: ${err?.message || err}`);
    if (!shuttingDown) {
      shutdown(1);
    }
  });

  return child;
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  log("[orchestrator] shutting down child processes...");

  const killers = childProcs.map(({ prefix, child }) =>
    killProcess(child, prefix),
  );
  await Promise.all(killers);

  process.exit(exitCode);
}

function killProcess(child, prefix) {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      return resolve();
    }

    const finish = () => resolve();

    if (isWin) {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      killer.on("close", finish);
      killer.on("error", () => finish());
    } else {
      child.kill("SIGINT");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
        finish();
      }, 500);
    }
  });
}

function pipeOutput(child, prefix) {
  const handleStream = (stream) => {
    if (!stream) return;
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) {
          log(prefix);
        } else {
          logPrefixed(prefix, line);
        }
      }
    });
    stream.on("end", () => {
      if (buffer.length > 0) {
        logPrefixed(prefix, buffer);
      }
    });
  };

  handleStream(child.stdout);
  handleStream(child.stderr);
}

async function startComfy() {
  const comfyDir = process.env.COMFYUI_DIR;
  if (!comfyDir) {
    throw new Error("COMFYUI_DIR is required to launch ComfyUI");
  }

  const listen = process.env.COMFYUI_LISTEN || "127.0.0.1";
  const port = process.env.COMFYUI_PORT || "8188";
  const comfyUrl = `http://${listen}:${port}/`;

  const pythonEnv = process.env.COMFYUI_PYTHON;
  const defaultPython = join(comfyDir, "venv", "Scripts", "python.exe");
  const python =
    pythonEnv || (existsSync(defaultPython) ? defaultPython : "python");

  const extraArgs = parseExtraArgs(process.env.COMFYUI_EXTRA_ARGS);
  const comfyArgs = ["main.py", "--listen", listen, "--port", String(port), ...extraArgs];

  const alreadyUp = await waitForHttpOk(comfyUrl, 3, 500);
  if (alreadyUp) {
    log(`[comfy] already running at ${comfyUrl}`);
    return;
  }

  log(`[comfy] starting with ${python} ${comfyArgs.join(" ")}`);
  spawnService("[comfy]", {
    cmd: python,
    args: comfyArgs,
    options: { cwd: comfyDir },
  });

  const ready = await waitForHttpOk(comfyUrl, 30, 1000);
  if (ready) {
    log(`[comfy] ready: ${comfyUrl}`);
  } else {
    log("[comfy] did not become ready within expected time");
  }
}

function parseExtraArgs(raw) {
  if (!raw || !raw.trim()) return [];
  const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return tokens.map((token) => token.replace(/^"(.*)"$/, "$1"));
}

async function waitForHttpOk(url, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        return true;
      }
    } catch (err) {
      // ignore network errors during retry
    }

    if (i < attempts - 1) {
      await sleep(delayMs);
    }
  }
  return false;
}
