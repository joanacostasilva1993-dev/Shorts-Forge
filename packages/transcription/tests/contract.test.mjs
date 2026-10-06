// AGPL-3.0-only
// Contract tests for the transcription microservice (frozen contract):
//   GET  /health     -> { ok: true, modelsLoaded: [...] }
//   POST /transcribe { audioPath } -> TranscriptionResult
//
// These tests run against the REAL service with the REAL faster-whisper
// model on a REAL Portuguese audio sample — no mocks anywhere.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService, findPython, FIXTURE_WAV } from "./helper.mjs";

let svc;
let skipped = false;

before(async () => {
  try {
    findPython();
  } catch (err) {
    skipped = true;
    console.warn(`[contract] A SALTAR: ${err.message}`);
    return;
  }
  svc = await startService();
});

after(async () => {
  if (svc) await svc.stop();
});

const onlyIfReady = (name, opts, fn) =>
  test(name, { ...opts, skip: skipped || undefined }, async (t) => {
    if (!svc) t.skip("serviço indisponível");
    else await fn(t);
  });

onlyIfReady("GET /health responde { ok: true, modelsLoaded: [...] }", {}, async () => {
  const res = await fetch(`${svc.base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.modelsLoaded), "modelsLoaded deve ser um array");
  assert.ok(body.modelsLoaded.length > 0, "modelos carregados não deve estar vazio");
});

onlyIfReady(
  "POST /transcribe em áudio português real devolve texto + word timestamps",
  { timeout: 600000 },
  async () => {
    const res = await fetch(`${svc.base}/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audioPath: FIXTURE_WAV }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    // TranscriptionResult shape
    assert.equal(typeof body.text, "string");
    assert.ok(body.text.length > 0, "texto não deve estar vazio");
    assert.equal(typeof body.language, "string");

    // The fixture says "Olá! Tudo bem?" — check the words are really there.
    const spoken = body.text.toLowerCase();
    assert.ok(spoken.includes("olá"), `texto deve conter "olá" (foi: ${body.text})`);
    assert.ok(spoken.includes("tudo"), `texto deve conter "tudo" (foi: ${body.text})`);
    assert.ok(spoken.includes("bem"), `texto deve conter "bem" (foi: ${body.text})`);

    // Word-level timestamps: the heart of the contract.
    assert.ok(Array.isArray(body.words), "words deve ser um array");
    assert.ok(body.words.length >= 3, `esperadas >= 3 palavras (foram ${body.words.length})`);
    let prevEnd = -1;
    for (const w of body.words) {
      assert.equal(typeof w.word, "string");
      assert.ok(w.word.length > 0);
      assert.equal(typeof w.start, "number");
      assert.equal(typeof w.end, "number");
      assert.ok(Number.isFinite(w.start) && Number.isFinite(w.end));
      assert.ok(w.start >= 0, "start >= 0");
      assert.ok(w.end > w.start, `end (${w.end}) > start (${w.start}) para "${w.word}"`);
      assert.ok(w.start >= prevEnd - 0.001, "palavras ordenadas no tempo");
      prevEnd = w.end;
    }
    assert.ok(prevEnd <= 3.0, `fim da última palavra (${prevEnd}s) dentro do áudio de 2.38s`);
  }
);

onlyIfReady("POST /transcribe com ficheiro inexistente -> 404 audio_not_found", {}, async () => {
  const res = await fetch(`${svc.base}/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audioPath: "/nao/existe/para/testar.wav" }),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, "audio_not_found");
  assert.equal(typeof body.error.message, "string");
});

onlyIfReady("POST /transcribe sem audioPath -> 400 invalid_request", {}, async () => {
  const res = await fetch(`${svc.base}/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "invalid_request");
});

onlyIfReady("POST /transcribe com ficheiro não-áudio -> 422 decode_error", {}, async () => {
  const fake = join(tmpdir(), `falso-${Date.now()}.wav`);
  writeFileSync(fake, "isto não é um ficheiro de áudio");
  const res = await fetch(`${svc.base}/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audioPath: fake }),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error.code, "decode_error");
});

onlyIfReady("rotas/métodos desconhecidos devolvem erro JSON", {}, async () => {
  const r1 = await fetch(`${svc.base}/nao-existe`);
  assert.equal(r1.status, 404);
  assert.equal((await r1.json()).error.code, "not_found");

  const r2 = await fetch(`${svc.base}/transcribe`, { method: "PUT" });
  assert.equal(r2.status, 405);
  assert.equal((await r2.json()).error.code, "method_not_allowed");
});
