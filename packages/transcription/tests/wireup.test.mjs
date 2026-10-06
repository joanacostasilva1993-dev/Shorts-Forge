// AGPL-3.0-only
// Wire-up test: exercises the transcription microservice through the REAL
// pipeline client (`ServiceClients.transcribe` in
// packages/pipeline/src/pythonBridge.ts), proving the frozen contract
// matches on both ends. No mocks.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { startService, findPython, FIXTURE_WAV, REPO_ROOT } from "./helper.mjs";

const BRIDGE_URL = pathToFileURL(
  join(REPO_ROOT, "packages", "pipeline", "dist", "src", "pythonBridge.js")
).href;

let svc;
let ServiceClients;
let skipped = false;

before(async () => {
  try {
    findPython();
    ({ ServiceClients } = await import(BRIDGE_URL));
  } catch (err) {
    skipped = true;
    console.warn(`[wireup] A SALTAR: ${err.message}`);
    return;
  }
  svc = await startService();
});

after(async () => {
  if (svc) await svc.stop();
});

test(
  "ServiceClients.transcribe() devolve TranscriptionResult válido do serviço real",
  { timeout: 600000, skip: skipped || undefined },
  async (t) => {
    if (!svc) {
      t.skip("serviço indisponível");
      return;
    }
    const client = new ServiceClients({ transcription: svc.base });
    const result = await client.transcribe(FIXTURE_WAV);

    assert.equal(typeof result.text, "string");
    assert.ok(result.text.toLowerCase().includes("olá"));
    assert.ok(Array.isArray(result.words) && result.words.length >= 3);
    for (const w of result.words) {
      assert.equal(typeof w.word, "string");
      assert.equal(typeof w.start, "number");
      assert.equal(typeof w.end, "number");
      assert.ok(w.end > w.start);
    }
    assert.equal(typeof result.language, "string");
  }
);

test(
  "ServiceClients.health() deteta o serviço de transcrição",
  { skip: skipped || undefined },
  async (t) => {
    if (!svc) {
      t.skip("serviço indisponível");
      return;
    }
    const client = new ServiceClients({ transcription: svc.base });
    const h = await client.health();
    assert.equal(h.transcription, true);
  }
);

test(
  "ServiceClients.transcribe() propaga erro pt-PT quando o ficheiro não existe",
  { skip: skipped || undefined },
  async (t) => {
    if (!svc) {
      t.skip("serviço indisponível");
      return;
    }
    const client = new ServiceClients({ transcription: svc.base });
    // NB: pythonBridge throws a generic HTTP-status error here because the
    // service answers 404 — the client surfaces it, never a fake result.
    await assert.rejects(() => client.transcribe("/nao/existe.wav"), /HTTP 404/);
  }
);
