// AGPL-3.0-only
// Test helper: spawns the real transcription service on a test port and
// waits until the model is loaded. No mocks — the service transcribes for real.

import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..");
export const SERVICE_DIR = join(REPO_ROOT, "packages", "transcription", "service");
export const FIXTURE_WAV = join(HERE, "fixtures", "amostra-pt.wav");
export const TEST_PORT = Number(process.env.TRANSCRIPTION_TEST_PORT || 18002);

/** Find a python3 with faster-whisper importable. Throws when none exists. */
export function findPython() {
  const explicit = process.env.TRANSCRIPTION_TEST_PYTHON;
  const candidates = explicit ? [explicit, "python3"] : ["python3"];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["-c", "import faster_whisper"], { stdio: "ignore" });
      return bin;
    } catch {
      // try next
    }
  }
  throw new Error(
    "faster-whisper não está instalado em nenhum python3 visível. " +
      "Instala com: python3 -m venv .venv && .venv/bin/pip install -r packages/transcription/service/requirements.txt " +
      "e define TRANSCRIPTION_TEST_PYTHON para esse python."
  );
}

export async function waitForHealth(base, { timeoutMs = 300000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        const body = await res.json();
        if (body.ok && Array.isArray(body.modelsLoaded) && body.modelsLoaded.length > 0) {
          return body;
        }
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`serviço não ficou pronto em ${timeoutMs}ms (${base}/health)`);
    }
    await sleep(2000);
  }
}

/** Start the service; returns { base, stop }. */
export async function startService() {
  const python = findPython();
  const base = `http://127.0.0.1:${TEST_PORT}`;
  const proc = spawn(
    python,
    [join(SERVICE_DIR, "server.py")],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TRANSCRIPTION_PORT: String(TEST_PORT),
        WHISPER_MODEL: process.env.WHISPER_MODEL || "small",
        WHISPER_EAGER_LOAD: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let logged = "";
  proc.stderr.on("data", (d) => {
    logged += d.toString();
  });
  proc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[tests] o serviço terminou (código ${code}):\n${logged}`);
    }
  });
  try {
    await waitForHealth(base);
  } catch (err) {
    proc.kill();
    throw new Error(`${err.message}\n--- stderr do serviço ---\n${logged}`);
  }
  return {
    base,
    async stop() {
      proc.kill();
      await sleep(500);
    },
  };
}
