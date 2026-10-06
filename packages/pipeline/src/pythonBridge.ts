/**
 * Cliente HTTP REAL para os serviços Python da Fase 2.
 *
 * Os SERVIDORES (faster-whisper para transcrição; Kokoro, Edge-TTS e
 * Google Cloud TTS para TTS) ainda não existem — são implementados na
 * Fase 2. Este módulo é o cliente que vai falar com eles; está completo
 * e funcional contra o contrato abaixo.
 *
 * Contrato HTTP (loopback local):
 *   POST /transcribe  { audioPath: string }                        → TranscriptionResult
 *   POST /synthesize  { text, voice, rate, provider }              → TtsResult
 *   GET  /health                                                  → { ok: true, ... }
 *
 * DIVERGÊNCIA RESOLVIDA: o ARCHITECTURE.md §4.4 propunha
 * `{ text, voice, language }` para /synthesize. O contrato FINAL é
 * `{ text, voice, rate, provider }`: `rate` ganha a `language` porque a UI
 * já expõe um slider de velocidade (e o Google mapeia rate→speakingRate);
 * o idioma está codificado no nome da voz (ex. vozes `pt-PT-*`).
 * O servidor Python da Fase 2 deve implementar este contrato —
 * ver docs/tts-providers.md §4.
 */

import type { TranscriptionResult, TtsResult, Word } from '@shorts-forge/shared';

/** Voice provider selected for synthesis. Default 'kokoro' (local, free). */
export type TtsProvider = 'kokoro' | 'edge-tts' | 'google';

export interface ServiceBaseUrls {
  /** Base URL of the transcription service; default http://127.0.0.1:8001 */
  transcription?: string;
  /** Base URL of the TTS service; default http://127.0.0.1:8002 */
  tts?: string;
}

const DEFAULT_TRANSCRIPTION_URL = 'http://127.0.0.1:8001';
const DEFAULT_TTS_URL = 'http://127.0.0.1:8002';
const HEALTH_TIMEOUT_MS = 3000;
const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000; // whisper on long audio takes a while
const SYNTHESIZE_TIMEOUT_MS = 5 * 60 * 1000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isWordArray(v: unknown): v is Word[] {
  return (
    Array.isArray(v) &&
    v.every(
      (w) =>
        typeof w === 'object' &&
        w !== null &&
        typeof (w as Word).word === 'string' &&
        typeof (w as Word).start === 'number' &&
        typeof (w as Word).end === 'number',
    )
  );
}

function assertTranscription(data: unknown): TranscriptionResult {
  if (typeof data !== 'object' || data === null) {
    throw new Error('resposta inválida do serviço de transcrição (não é um objeto)');
  }
  const d = data as Record<string, unknown>;
  if (typeof d['text'] !== 'string' || !isWordArray(d['words']) || typeof d['language'] !== 'string') {
    throw new Error('resposta inválida do serviço de transcrição (falta text/words/language)');
  }
  return { text: d['text'], words: d['words'], language: d['language'] };
}

function assertTts(data: unknown): TtsResult {
  if (typeof data !== 'object' || data === null) {
    throw new Error('resposta inválida do serviço de TTS (não é um objeto)');
  }
  const d = data as Record<string, unknown>;
  if (
    typeof d['audioPath'] !== 'string' ||
    !isWordArray(d['words']) ||
    typeof d['durationSec'] !== 'number' ||
    typeof d['voice'] !== 'string'
  ) {
    throw new Error('resposta inválida do serviço de TTS (falta audioPath/words/durationSec/voice)');
  }
  return {
    audioPath: d['audioPath'],
    words: d['words'],
    durationSec: d['durationSec'],
    voice: d['voice'],
  };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new Error(`resposta não-JSON do serviço (HTTP ${res.status})`);
  }
}

/**
 * HTTP client for the Phase 2 Python services (transcription + TTS).
 * Stateless — safe to share across jobs.
 */
export class ServiceClients {
  readonly transcriptionBase: string;
  readonly ttsBase: string;

  constructor(baseUrls: ServiceBaseUrls = {}) {
    this.transcriptionBase = (baseUrls.transcription ?? DEFAULT_TRANSCRIPTION_URL).replace(/\/+$/, '');
    this.ttsBase = (baseUrls.tts ?? DEFAULT_TTS_URL).replace(/\/+$/, '');
  }

  /**
   * POST /transcribe { audioPath } → TranscriptionResult.
   * Throws a clear pt-PT Error when the Phase 2 service is unreachable.
   */
  async transcribe(audioPath: string): Promise<TranscriptionResult> {
    let res: Response;
    try {
      res = await fetch(`${this.transcriptionBase}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audioPath }),
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `serviço de transcrição indisponível — Fase 2 (sem ligação a ${this.transcriptionBase}): ${errMsg(err)}`,
      );
    }
    if (!res.ok) {
      throw new Error(`serviço de transcrição respondeu HTTP ${res.status} — Fase 2`);
    }
    return assertTranscription(await readJson(res));
  }

  /**
   * POST /synthesize { text, voice, rate, provider } → TtsResult (with word timestamps).
   *
   * @param text Text to synthesize.
   * @param voice Voice identifier (language is encoded in the voice name, e.g. `pt-PT-*`).
   * @param rate Speech rate multiplier (1.0 = normal); mapped to the provider's
   *   rate control (e.g. Google's `speakingRate`).
   * @param provider Voice provider; defaults to 'kokoro' (local, free).
   *   Mapping from the UI `TtsEngine`: kokoro → 'kokoro', edge → 'edge-tts',
   *   google → 'google'.
   * Throws a clear pt-PT Error when the Phase 2 service is unreachable.
   */
  async synthesize(
    text: string,
    voice: string,
    rate = 1.0,
    provider: TtsProvider = 'kokoro',
  ): Promise<TtsResult> {
    let res: Response;
    try {
      res = await fetch(`${this.ttsBase}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice, rate, provider }),
        signal: AbortSignal.timeout(SYNTHESIZE_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `serviço de TTS indisponível — Fase 2 (sem ligação a ${this.ttsBase}): ${errMsg(err)}`,
      );
    }
    if (!res.ok) {
      throw new Error(`serviço de TTS respondeu HTTP ${res.status} — Fase 2`);
    }
    return assertTts(await readJson(res));
  }

  /**
   * Probes GET /health on both services. Never throws — reports reachability.
   */
  async health(): Promise<{ transcription: boolean; tts: boolean }> {
    const probe = async (base: string): Promise<boolean> => {
      try {
        const res = await fetch(`${base}/health`, {
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        return res.ok;
      } catch {
        return false;
      }
    };
    const [transcription, tts] = await Promise.all([
      probe(this.transcriptionBase),
      probe(this.ttsBase),
    ]);
    return { transcription, tts };
  }
}
