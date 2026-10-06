/**
 * Fase B — re-temporização da Spec com os timestamps REAIS do TTS.
 *
 * Regra central da arquitetura ("medir, não estimar"): depois de o TTS
 * gerar o áudio real de cada segmento, a duração de cada plano passa a ser
 * o fim da última palavra falada + uma pequena margem de respiro. Nada de
 * estimativas por contagem de palavras.
 *
 * - Função pura: sem I/O, sem efeitos laterais, devolve uma NOVA Spec.
 * - Segmentos sem resultado de TTS mantêm `targetDurationSec` e ficam sem
 *   `actualDurationSec` — nunca se inventa temporização.
 * - Um resultado de TTS sem palavras também não produz
 *   `actualDurationSec` (não há fim de palavra para medir), mas o áudio é
 *   na mesma anexado ao segmento.
 */

import type { Spec, TtsResult } from '@shorts-forge/shared';

export interface RetimeOptions {
  /**
   * Silence appended after the last spoken word, in seconds.
   * Default 0.25 — a small "breath" so cuts don't feel abrupt.
   */
  breathMarginSec?: number;
}

export const DEFAULT_BREATH_MARGIN_SEC = 0.25;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Re-times every segment from real TTS word timestamps.
 *
 * @param spec        Phase A Spec (never mutated).
 * @param ttsBySegment Map of segment id → TTS result for that segment.
 * @param opts        Optional breath margin override.
 * @returns           A NEW Spec with `tts` attached and `actualDurationSec`
 *                    set wherever real timing exists.
 */
export function retimeSpec(
  spec: Spec,
  ttsBySegment: Map<string, TtsResult>,
  opts: RetimeOptions = {},
): Spec {
  const margin = opts.breathMarginSec ?? DEFAULT_BREATH_MARGIN_SEC;
  if (!Number.isFinite(margin) || margin < 0) {
    throw new Error('retimeSpec: "breathMarginSec" tem de ser um número >= 0');
  }

  const segments = spec.segments.map((segment) => {
    const tts = ttsBySegment.get(segment.id);
    if (!tts) {
      // No TTS for this segment: keep the plan, invent nothing.
      return { ...segment };
    }

    const words = Array.isArray(tts.words) ? tts.words : [];
    const ends = words.map((w) => w.end).filter((e) => Number.isFinite(e));
    const lastWordEnd = ends.length > 0 ? Math.max(...ends) : undefined;

    return {
      ...segment,
      tts: {
        audioPath: tts.audioPath,
        words: words.map((w) => ({ ...w })),
        durationSec: tts.durationSec,
      },
      // exactOptionalPropertyTypes: only add the key when we measured it.
      ...(lastWordEnd === undefined ? {} : { actualDurationSec: round3(lastWordEnd + margin) }),
    };
  });

  return { ...spec, segments };
}

/** Total video duration = sum of real segment durations (Phase B). */
export function totalDurationSec(spec: Spec): number {
  return round3(
    spec.segments.reduce(
      (acc, s) => acc + (s.actualDurationSec ?? s.targetDurationSec),
      0,
    ),
  );
}
