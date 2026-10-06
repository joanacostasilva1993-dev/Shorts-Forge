#!/usr/bin/env node
// AGPL-3.0-only
//
// models:download — downloads AI model weights into ./models/ (gitignored).
//
// Sections:
//   - faster-whisper (transcription engineer): the model named by
//     WHISPER_MODEL (default "small") -> ./models/whisper/<name>/.
//   - Kokoro (TTS engineer): hexgrad/Kokoro-82M (~325MB) -> ./models/kokoro/
//     (kokoro-v1_0.pth, config.json and voices/*.pt directly inside).
//
// Keep each model's section self-contained and idempotent.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// faster-whisper model name -> Hugging Face repo id (CTranslate2 format).
const WHISPER_REPOS = {
  tiny: "guillaumekln/faster-whisper-tiny",
  base: "guillaumekln/faster-whisper-base",
  small: "guillaumekln/faster-whisper-small",
  medium: "guillaumekln/faster-whisper-medium",
  large: "guillaumekln/faster-whisper-large",
  "large-v2": "guillaumekln/faster-whisper-large-v2",
  "large-v3": "guillaumekln/faster-whisper-large-v3",
  "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
  turbo: "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
};

// Kokoro TTS model (used by packages/tts/service, provider "kokoro").
const KOKORO_REPO = "hexgrad/Kokoro-82M";

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.split("=")[1] : "all";
if (!["all", "kokoro", "whisper"].includes(only)) {
  console.error(
    `[models:download] ERRO: --only inválido: "${only}" (usa kokoro, whisper ou all)`
  );
  process.exit(1);
}

function python3(args, opts = {}) {
  return spawnSync("python3", args, { stdio: "inherit", ...opts });
}

function ensureHuggingFaceHub() {
  const check = spawnSync("python3", ["-c", "import huggingface_hub"], {
    stdio: "ignore",
  });
  if (check.status === 0) return;
  console.log(
    "[models:download] a instalar huggingface_hub (só para o download)…"
  );
  execFileSync(
    "python3",
    ["-m", "pip", "install", "--quiet", "huggingface_hub>=0.23"],
    { stdio: "inherit" }
  );
}

function sanitizedEnv() {
  // Workaround: httpx 0.28.x (via huggingface_hub) crashes on bracketed IPv6
  // entries in NO_PROXY (e.g. "[::1]"). Irrelevant for huggingface.co, so
  // strip them for the download child process.
  const env = { ...process.env };
  for (const v of ["NO_PROXY", "no_proxy"]) {
    if (env[v]) env[v] = env[v].split(",").filter((e) => !e.includes("[") && !e.includes("]")).join(",");
  }
  return env;
}

function downloadWhisper(modelName) {
  const repoId = WHISPER_REPOS[modelName];
  if (!repoId) {
    console.error(
      `[models:download] ERRO: modelo faster-whisper desconhecido: "${modelName}".\n` +
        `  Modelos suportados: ${Object.keys(WHISPER_REPOS).join(", ")}\n` +
        "  (define WHISPER_MODEL com um destes nomes)"
    );
    process.exit(1);
  }
  const targetDir = join(REPO_ROOT, "models", "whisper", modelName);
  if (existsSync(join(targetDir, "model.bin"))) {
    console.log(
      `[models:download] faster-whisper "${modelName}" já existe em ${targetDir} — a saltar.`
    );
    return;
  }
  mkdirSync(targetDir, { recursive: true });
  ensureHuggingFaceHub();
  console.log(
    `[models:download] a sacar faster-whisper "${modelName}" (${repoId}) para ${targetDir}…`
  );
  const dl = spawnSync(
    "python3",
    [
      "-c",
      "from huggingface_hub import snapshot_download; " +
        "import sys; " +
        "snapshot_download(repo_id=sys.argv[1], local_dir=sys.argv[2])",
      repoId,
      targetDir,
    ],
    { stdio: "inherit", env: sanitizedEnv() }
  );
  if (dl.status !== 0) {
    console.error(
      "[models:download] ERRO: falhou o download do modelo faster-whisper."
    );
    process.exit(dl.status ?? 1);
  }
  console.log(`[models:download] OK: modelo em ${targetDir}`);
}

function downloadKokoro() {
  const targetDir = join(REPO_ROOT, "models", "kokoro");
  if (existsSync(join(targetDir, "kokoro-v1_0.pth"))) {
    console.log(
      `[models:download] Kokoro-82M já existe em ${targetDir} — a saltar.`
    );
    return;
  }
  mkdirSync(targetDir, { recursive: true });
  ensureHuggingFaceHub();
  console.log(
    `[models:download] a sacar Kokoro-82M (~325MB, ${KOKORO_REPO}) para ${targetDir}…`
  );
  const dl = spawnSync(
    "python3",
    [
      "-c",
      "from huggingface_hub import snapshot_download; " +
        "import sys; " +
        "snapshot_download(repo_id=sys.argv[1], local_dir=sys.argv[2])",
      KOKORO_REPO,
      targetDir,
    ],
    { stdio: "inherit", env: sanitizedEnv() }
  );
  if (dl.status !== 0) {
    console.error("[models:download] ERRO: falhou o download do modelo Kokoro.");
    process.exit(dl.status ?? 1);
  }
  console.log(`[models:download] OK: modelo em ${targetDir}`);
}

const whisperModel = (process.env.WHISPER_MODEL || "small").trim();
if (only === "all" || only === "whisper") downloadWhisper(whisperModel);
if (only === "all" || only === "kokoro") downloadKokoro();
console.log("[models:download] concluído.");
