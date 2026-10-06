/**
 * Controlo de qualidade automático (QC) — Fase 4.
 *
 * Etapa automática entre o render e o estado `done`: analisa o
 * `final.mp4` com ffprobe/filtros FFmpeg reais e só deixa o job avançar
 * para `done` quando todas as verificações passam. Um vídeo que chumbe
 * vai para `qc-failed` (com motivos em pt-PT) e o `/download` recusa-se
 * a servi-lo (409 honesto).
 *
 * Limiares (racional documentado em ARCHITECTURE.md §8.3):
 * - duração: tolerância = max(±1.5 s, ±5%) da soma de actualDurationSec
 * - áudio: tem de existir stream de áudio E ≥ 1.0 s de áudio não-silencioso
 *   (silencedetect a −40 dB)
 * - legendas: captions.srt presente, nº de palavras dentro de max(5, ±5%)
 *   das palavras narradas na Spec
 * - preto: nenhum segmento preto contínuo > 1.0 s (blackdetect)
 * - congelado: nenhum segmento de vídeo parado > 1.0 s (freezedetect)
 * - loudness: integrada em −16 LUFS ± 2 (o alvo que a montagem já usa no
 *   loudnorm; ±2 dá margem ao loudnorm de passagem única)
 * - clipping: nenhum pico a 0 dBFS (Max level ≥ 1.0 no astats) = distorção
 * - silêncio inesperado: nenhum silêncio > 0.8 s dentro do span narrado de
 *   um segmento que a Spec (words[] reais do TTS) não prevê = possível
 *   corte/glitch de TTS
 * - corte abrupto (AVISO, nunca chumba): queda/subida brusca de energia
 *   numa fronteira de segmento (volumedetect em janelas de 0.1 s)
 *
 * Âmbito honesto (princípio da Joana: naturalidade da voz é o critério
 * nº 1): nenhum algoritmo deteta "roboticidade" de forma fiável — a
 * aprovação humana das vozes continua a ser o árbitro da naturalidade.
 * O QC deteta apenas artefactos mensuráveis (distorção, buracos, cortes).
 * Para diagnóstico, o relatório inclui o provider e a voz de TTS usados.
 *
 * Nada aqui é estimado ou simulado: cada check corre ffprobe/ffmpeg
 * reais sobre o ficheiro final. Se as ferramentas falharem, o check
 * chumba (fail-closed) com o motivo registado — nunca passa "por defeito".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { Spec } from '@shorts-forge/shared';

/** Nome do relatório escrito em `outputs/<jobId>/qc-report.json`. */
export const QC_REPORT_FILENAME = 'qc-report.json';
/** Nome da legenda lateral escrita na Fase B (`outputs/<jobId>/captions.srt`). */
export const QC_CAPTION_FILENAME = 'captions.srt';

export interface QcThresholds {
  /** Tolerância absoluta de duração, em segundos. */
  durationToleranceSec: number;
  /** Tolerância relativa de duração (fração da duração esperada). */
  durationToleranceRatio: number;
  /** Duração máxima de um segmento preto contínuo, em segundos. */
  maxBlackSec: number;
  /** Duração máxima de um segmento de vídeo congelado, em segundos. */
  maxFreezeSec: number;
  /** Limiar de silêncio do silencedetect, em dB. */
  silenceNoiseDb: number;
  /** Áudio não-silencioso mínimo exigido, em segundos. */
  minNonSilentSec: number;
  /** Loudness integrada alvo, em LUFS. */
  loudnessTargetLufs: number;
  /** Tolerância da loudness integrada, em LU. */
  loudnessToleranceLufs: number;
  /** Tolerância absoluta da contagem de palavras das legendas. */
  captionWordTolerance: number;
  /** Tolerância relativa da contagem de palavras das legendas. */
  captionWordToleranceRatio: number;
  /**
   * Pico máximo admitido (linear; 1.0 = 0 dBFS). Max level ≥ 1.0 no
   * astats = amostras a fundo de escala = clipping/distorção.
   */
  maxClipPeakLevel: number;
  /**
   * Duração de um silêncio a partir da qual ele é "inesperado" quando a
   * Spec não prevê pausa nenhuma nesse ponto (words[] reais do TTS).
   * 0.8 s: pausas naturais de respiração ficam abaixo; um buraco de TTS
   * (frase cortada, glitch) fica acima.
   */
  unexpectedSilenceSec: number;
  /** Janela de análise do volumedetect de cada lado da fronteira (s). */
  abruptCutWindowSec: number;
  /** "Há energia" se max_volume ≥ este valor (dB). */
  abruptCutHighDb: number;
  /** "Há silêncio" se mean_volume ≤ este valor (dB). */
  abruptCutLowDb: number;
}

export const QC_THRESHOLDS: QcThresholds = {
  durationToleranceSec: 1.5,
  durationToleranceRatio: 0.05,
  maxBlackSec: 1.0,
  maxFreezeSec: 1.0,
  silenceNoiseDb: -40,
  minNonSilentSec: 1.0,
  loudnessTargetLufs: -16,
  loudnessToleranceLufs: 2,
  captionWordTolerance: 5,
  captionWordToleranceRatio: 0.05,
  maxClipPeakLevel: 1.0,
  unexpectedSilenceSec: 0.8,
  abruptCutWindowSec: 0.1,
  abruptCutHighDb: -20,
  abruptCutLowDb: -45,
};

export type QcCheckName =
  | 'audio-present'
  | 'duration'
  | 'captions'
  | 'no-black'
  | 'no-freeze'
  | 'loudness'
  | 'no-clipping'
  | 'no-unexpected-silence'
  | 'no-abrupt-cut';

export const QC_CHECK_NAMES: readonly QcCheckName[] = [
  'audio-present',
  'duration',
  'captions',
  'no-black',
  'no-freeze',
  'loudness',
  'no-clipping',
  'no-unexpected-silence',
  'no-abrupt-cut',
];

/**
 * Gravidade do check. `warning` nunca chumba o QC — serve para sinais
 * pouco fiáveis ou informativos (ex. possível corte abrupto), que vão
 * para o relatório para a Joana decidir.
 */
export type QcSeverity = 'error' | 'warning';

export interface QcCheckResult {
  name: QcCheckName;
  passed: boolean;
  severity: QcSeverity;
  /** Detalhe técnico em inglês (para logs/depuração). */
  details: string;
  /** Motivo do chumbo em pt-PT (só quando severity=error e passed=false). */
  reasonPt?: string;
  /** Aviso em pt-PT (só quando severity=warning e há algo a assinalar). */
  warningPt?: string;
}

/**
 * Relatório de QC.
 *
 * `schema` + `version` mantêm o formato estável para a Fase 6
 * (biblioteca de projetos: o project.yaml referencia este relatório).
 */
export interface QcReport {
  schema: 'shorts-forge/qc-report';
  version: 1;
  jobId: string;
  videoPath: string;
  captionPath?: string;
  generatedAt: string;
  passed: boolean;
  thresholds: QcThresholds;
  checks: QcCheckResult[];
  /**
   * Rastreabilidade do TTS (para diagnóstico: "este render usou que voz?").
   * O pipeline usa uma voz por job — estes são os valores resolvidos na
   * Fase B (escolha da UI > env > catálogo do idioma).
   */
  tts?: {
    provider: string;
    voice: string;
    rate: number;
  };
  /** Resumo por segmento (durações reais + palavras + áudio usado). */
  segments: QcSegmentInfo[];
}

/** Info de diagnóstico por segmento no relatório de QC. */
export interface QcSegmentInfo {
  id: string;
  actualDurationSec: number;
  wordCount: number;
  audioPath?: string;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ffmpegAvailable(): boolean {
  try {
    const probe = spawnSync('ffprobe', ['-hide_banner', '-version'], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    const enc = spawnSync('ffmpeg', ['-hide_banner', '-version'], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    return probe.status === 0 && enc.status === 0;
  } catch {
    return false;
  }
}

function runFfprobe(args: string[]): string {
  const res = spawnSync('ffprobe', ['-hide_banner', '-v', 'error', ...args], {
    timeout: 60_000,
    encoding: 'utf8',
  });
  if (res.error) throw new Error(`ffprobe não executou: ${errText(res.error)}`);
  if (res.status !== 0) {
    throw new Error(`ffprobe falhou (exit ${res.status}): ${String(res.stderr ?? '').slice(-2000)}`);
  }
  return String(res.stdout ?? '');
}

/** Corre o ffmpeg com um filtro de análise e devolve o stderr (onde os filtros logam). */
function runFfmpegAnalysis(args: string[]): string {
  const res = spawnSync('ffmpeg', ['-hide_banner', ...args], {
    timeout: 10 * 60_000,
    encoding: 'utf8',
  });
  if (res.error) throw new Error(`ffmpeg não executou: ${errText(res.error)}`);
  if (res.status !== 0) {
    throw new Error(`ffmpeg falhou (exit ${res.status}): ${String(res.stderr ?? '').slice(-2000)}`);
  }
  return String(res.stderr ?? '');
}

// ── Legendas (SRT) ─────────────────────────────────────────────────

function srtTimestamp(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/**
 * Escreve `captions.srt` a partir das palavras reais (TTS) da Spec
 * re-temporizada. Os tempos de cada segmento são deslocados pelo
 * acumulado dos segmentos anteriores. Sem palavras TTS, cada segmento
 * vira uma legenda única com a narração completa (degradação honesta,
 * registada no detalhe do check).
 */
export function writeCaptionsSrt(spec: Spec, outPath: string): string {
  const lines: string[] = [];
  let cue = 1;
  let offset = 0;
  for (const segment of spec.segments) {
    const words = segment.tts?.words ?? [];
    if (words.length > 0) {
      for (const w of words) {
        lines.push(
          String(cue++),
          `${srtTimestamp(offset + w.start)} --> ${srtTimestamp(offset + w.end)}`,
          w.word,
          '',
        );
      }
    } else {
      const dur = segment.actualDurationSec ?? segment.targetDurationSec;
      lines.push(
        String(cue++),
        `${srtTimestamp(offset)} --> ${srtTimestamp(offset + dur)}`,
        segment.narration,
        '',
      );
    }
    offset += segment.actualDurationSec ?? segment.targetDurationSec;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join('\n'), 'utf8');
  return outPath;
}

/** Conta as palavras do texto das legendas de um ficheiro SRT. */
export function countSrtWords(srtPath: string): number {
  const text = readFileSync(srtPath, 'utf8');
  const blocks = text.split(/\r?\n\r?\n/);
  let count = 0;
  for (const block of blocks) {
    const rows = block.split(/\r?\n/).filter((r) => r.trim().length > 0);
    // Formato: número, "00:00:00,000 --> 00:00:01,000", texto…
    const textRows = rows.slice(2);
    for (const row of textRows) {
      count += row
        .replace(/<[^>]*>/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 0).length;
    }
  }
  return count;
}

/** Nº de palavras narradas na Spec (palavras reais do TTS quando existem). */
export function countSpecWords(spec: Spec): number {
  let count = 0;
  for (const segment of spec.segments) {
    const words = segment.tts?.words;
    if (words && words.length > 0) {
      count += words.length;
    } else {
      count += segment.narration.split(/\s+/).filter((w) => w.length > 0).length;
    }
  }
  return count;
}

// ── Checks individuais ─────────────────────────────────────────────

function probeDurationSec(videoPath: string): number {
  const out = runFfprobe([
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    videoPath,
  ]).trim();
  const dur = Number(out);
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new Error(`duração ilegível no ffprobe: "${out}"`);
  }
  return dur;
}

function probeStreamTypes(videoPath: string): string[] {
  const out = runFfprobe([
    '-show_entries',
    'stream=codec_type',
    '-of',
    'csv=p=0',
    videoPath,
  ]);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface SilenceWindow {
  start: number;
  end: number;
}

function detectSilenceWindows(videoPath: string): SilenceWindow[] {
  const log = runFfmpegAnalysis([
    '-i',
    videoPath,
    '-af',
    `silencedetect=noise=${QC_THRESHOLDS.silenceNoiseDb}dB:d=0.5`,
    '-f',
    'null',
    '-',
  ]);
  const windows: SilenceWindow[] = [];
  let pendingStart: number | null = null;
  for (const line of log.split('\n')) {
    const start = line.match(/silence_start:\s*([0-9.]+)/);
    if (start) {
      pendingStart = Number(start[1]);
      continue;
    }
    const end = line.match(/silence_end:\s*([0-9.]+)/);
    if (end && pendingStart !== null) {
      windows.push({ start: pendingStart, end: Number(end[1]) });
      pendingStart = null;
    }
  }
  return windows;
}

function checkAudioPresent(
  videoPath: string,
  silenceWindows: SilenceWindow[],
  silenceError: string | null,
): QcCheckResult {
  const name: QcCheckName = 'audio-present';
  try {
    const types = probeStreamTypes(videoPath);
    if (!types.includes('audio')) {
      return {
        name,
        passed: false,
        severity: 'error',
        details: `streams: [${types.join(', ')}] — no audio stream`,
        reasonPt: 'O vídeo não tem faixa de áudio.',
      };
    }
    if (silenceError) {
      return {
        name,
        passed: false,
        severity: 'error',
        details: `silencedetect failed: ${silenceError}`,
        reasonPt: 'Não foi possível analisar o áudio do vídeo (ferramenta de análise falhou).',
      };
    }
    const duration = probeDurationSec(videoPath);
    const windows = silenceWindows;
    const silentTotal = windows.reduce((acc, w) => acc + Math.max(0, w.end - w.start), 0);
    const longest = windows.reduce((acc, w) => Math.max(acc, w.end - w.start), 0);
    const nonSilent = Math.max(0, duration - silentTotal);
    if (nonSilent < QC_THRESHOLDS.minNonSilentSec) {
      return {
        name,
        passed: false,
        severity: 'error',
        details:
          `duration=${duration.toFixed(2)}s silent=${silentTotal.toFixed(2)}s ` +
          `non-silent=${nonSilent.toFixed(2)}s (< ${QC_THRESHOLDS.minNonSilentSec}s)`,
        reasonPt:
          'O áudio do vídeo está (quase) todo em silêncio — ' +
          'a narração não foi gravada na mistura final.',
      };
    }
    return {
      name,
      passed: true,
      severity: 'error',
      details:
        `audio stream ok; duration=${duration.toFixed(2)}s ` +
        `non-silent=${nonSilent.toFixed(2)}s longest-silence=${longest.toFixed(2)}s`,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      severity: 'error',
      details: `analysis failed: ${errText(err)}`,
      reasonPt: 'Não foi possível analisar o áudio do vídeo (ferramenta de análise falhou).',
    };
  }
}

function expectedDurationSec(spec: Spec): number {
  return spec.segments.reduce(
    (acc, s) => acc + (s.actualDurationSec ?? s.targetDurationSec),
    0,
  );
}

function checkDuration(videoPath: string, spec: Spec): QcCheckResult {
  const name: QcCheckName = 'duration';
  try {
    const expected = expectedDurationSec(spec);
    const tolerance = Math.max(
      QC_THRESHOLDS.durationToleranceSec,
      expected * QC_THRESHOLDS.durationToleranceRatio,
    );
    const actual = probeDurationSec(videoPath);
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
      return {
        name,
        passed: false,
        severity: 'error',
        details:
          `actual=${actual.toFixed(2)}s expected=${expected.toFixed(2)}s ` +
          `diff=${diff.toFixed(2)}s > tol=${tolerance.toFixed(2)}s`,
        reasonPt:
          `A duração do vídeo (${actual.toFixed(1)} s) desvia-se ` +
          `${diff.toFixed(1)} s da soma dos segmentos (${expected.toFixed(1)} s) — ` +
          'a montagem cortou ou esticou tempo a mais.',
      };
    }
    return {
      name,
      passed: true,
      severity: 'error',
      details: `actual=${actual.toFixed(2)}s expected=${expected.toFixed(2)}s diff=${diff.toFixed(2)}s`,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      severity: 'error',
      details: `analysis failed: ${errText(err)}`,
      reasonPt: 'Não foi possível medir a duração do vídeo final.',
    };
  }
}

function checkCaptions(captionPath: string | undefined, spec: Spec): QcCheckResult {
  const name: QcCheckName = 'captions';
  try {
    if (!captionPath || !existsSync(captionPath)) {
      return {
        name,
        passed: false,
        severity: 'error',
        details: `caption file missing: ${captionPath ?? '(none)'}`,
        reasonPt: 'Ficheiro de legendas em falta — as legendas não foram geradas.',
      };
    }
    const expected = countSpecWords(spec);
    const tolerance = Math.max(
      QC_THRESHOLDS.captionWordTolerance,
      Math.round(expected * QC_THRESHOLDS.captionWordToleranceRatio),
    );
    const actual = countSrtWords(captionPath);
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
      return {
        name,
        passed: false,
        severity: 'error',
        details:
          `srt words=${actual} spec words=${expected} ` +
          `diff=${diff} > tol=${tolerance}`,
        reasonPt:
          `As legendas têm ${actual} palavras mas a narração tem ${expected} — ` +
          'legendas dessincronizadas ou incompletas.',
      };
    }
    return {
      name,
      passed: true,
      severity: 'error',
      details: `srt words=${actual} spec words=${expected} diff=${diff}`,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      severity: 'error',
      details: `analysis failed: ${errText(err)}`,
      reasonPt: 'Não foi possível ler o ficheiro de legendas.',
    };
  }
}

function parseDurations(log: string, key: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`${key}:\\s*([0-9.]+)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(log)) !== null) out.push(Number(m[1]));
  return out;
}

function checkNoBlack(videoPath: string): QcCheckResult {
  const name: QcCheckName = 'no-black';
  try {
    const log = runFfmpegAnalysis([
      '-i',
      videoPath,
      '-vf',
      'blackdetect=d=1.0:pix_th=0.10',
      '-f',
      'null',
      '-',
    ]);
    const durations = parseDurations(log, 'black_duration');
    const longest = durations.reduce((acc, d) => Math.max(acc, d), 0);
    if (longest > QC_THRESHOLDS.maxBlackSec) {
      return {
        name,
        passed: false,
        severity: 'error',
        details: `black segments: [${durations.map((d) => d.toFixed(2)).join(', ')}]s`,
        reasonPt:
          `O vídeo tem ${longest.toFixed(1)} s seguidos de imagem preta — ` +
          'há um plano sem imagem (B-roll em falta ou corte mal feito).',
      };
    }
    return {
      name,
      passed: true,
      severity: 'error',
      details: `longest black segment=${longest.toFixed(2)}s (threshold ${QC_THRESHOLDS.maxBlackSec}s)`,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      severity: 'error',
      details: `analysis failed: ${errText(err)}`,
      reasonPt: 'Não foi possível verificar se há segmentos pretos no vídeo.',
    };
  }
}

function checkNoFreeze(videoPath: string): QcCheckResult {
  const name: QcCheckName = 'no-freeze';
  try {
    const duration = probeDurationSec(videoPath);
    const log = runFfmpegAnalysis([
      '-i',
      videoPath,
      '-vf',
      'freezedetect=n=0.003:d=1.0',
      '-f',
      'null',
      '-',
    ]);
    // freeze_start sem freeze_end correspondente = congelado até ao fim.
    const starts: number[] = [];
    const ends: number[] = [];
    for (const line of log.split('\n')) {
      const s = line.match(/freeze_start:\s*([0-9.]+)/);
      if (s) starts.push(Number(s[1]));
      const e = line.match(/freeze_end:\s*([0-9.]+)/);
      if (e) ends.push(Number(e[1]));
    }
    const durations = starts.map((s, i) => {
      const e = ends[i];
      return Math.max(0, (e ?? duration) - s);
    });
    const longest = durations.reduce((acc, d) => Math.max(acc, d), 0);
    if (longest > QC_THRESHOLDS.maxFreezeSec) {
      return {
        name,
        passed: false,
        severity: 'error',
        details: `frozen segments: [${durations.map((d) => d.toFixed(2)).join(', ')}]s`,
        reasonPt:
          `O vídeo tem ${longest.toFixed(1)} s seguidos de imagem parada — ` +
          'há um plano congelado (frame preso ou B-roll estático a mais).',
      };
    }
    return {
      name,
      passed: true,
      severity: 'error',
      details: `longest frozen segment=${longest.toFixed(2)}s (threshold ${QC_THRESHOLDS.maxFreezeSec}s)`,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      severity: 'error',
      details: `analysis failed: ${errText(err)}`,
      reasonPt: 'Não foi possível verificar se há imagem congelada no vídeo.',
    };
  }
}

function checkLoudness(videoPath: string): QcCheckResult {
  const name: QcCheckName = 'loudness';
  try {
    const log = runFfmpegAnalysis([
      '-i',
      videoPath,
      '-af',
      'loudnorm=print_format=json',
      '-f',
      'null',
      '-',
    ]);
    const blocks = log.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/g);
    const last = blocks?.[blocks.length - 1];
    const parsed = last ? (JSON.parse(last) as { input_i?: string }) : null;
    const integrated = parsed?.input_i !== undefined ? Number(parsed.input_i) : NaN;
    if (!Number.isFinite(integrated)) {
      throw new Error('loudnorm não devolveu "input_i" legível');
    }
    const lo = QC_THRESHOLDS.loudnessTargetLufs - QC_THRESHOLDS.loudnessToleranceLufs;
    const hi = QC_THRESHOLDS.loudnessTargetLufs + QC_THRESHOLDS.loudnessToleranceLufs;
    if (integrated < lo || integrated > hi) {
      return {
        name,
        passed: false,
        severity: 'error',
        details: `integrated=${integrated.toFixed(2)} LUFS target=${QC_THRESHOLDS.loudnessTargetLufs}±${QC_THRESHOLDS.loudnessToleranceLufs}`,
        reasonPt:
          `O volume do vídeo está a ${integrated.toFixed(1)} LUFS, fora do alvo ` +
          `(${lo} a ${hi} LUFS) — soa demasiado baixo ou alto nas plataformas.`,
      };
    }
    return {
      name,
      passed: true,
      severity: 'error',
      details: `integrated=${integrated.toFixed(2)} LUFS (target ${QC_THRESHOLDS.loudnessTargetLufs}±${QC_THRESHOLDS.loudnessToleranceLufs})`,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      severity: 'error',
      details: `analysis failed: ${errText(err)}`,
      reasonPt: 'Não foi possível medir o volume (loudness) do vídeo.',
    };
  }
}

// ── Artefactos de TTS ──────────────────────────────────────────────
// Âmbito honesto: o QC não mede "naturalidade" (isso continua a ser a
// gate humana de aprovação de vozes). Deteta apenas artefactos
// mensuráveis: distorção (clipping), buracos de silêncio onde a Spec
// prevê narração contínua, e cortes abruptos nas fronteiras.

/** Pico máximo (linear) do áudio via astats; 1.0 = 0 dBFS. */
function measureMaxPeakLevel(videoPath: string): number {
  const log = runFfmpegAnalysis(['-i', videoPath, '-af', 'astats=metadata=1', '-f', 'null', '-']);
  let peak = 0;
  for (const line of log.split('\n')) {
    const m = line.match(/Max level:\s*([0-9.]+)/);
    if (m) peak = Math.max(peak, Number(m[1]));
  }
  return peak;
}

function checkNoClipping(videoPath: string): QcCheckResult {
  const name: QcCheckName = 'no-clipping';
  try {
    const peak = measureMaxPeakLevel(videoPath);
    if (peak >= QC_THRESHOLDS.maxClipPeakLevel) {
      return {
        name,
        passed: false,
        severity: 'error',
        details: `max peak level=${peak.toFixed(3)} (>= ${QC_THRESHOLDS.maxClipPeakLevel} = 0 dBFS)`,
        reasonPt:
          'O áudio tem distorção (clipping) — a narração foi gravada ' +
          'demasiado alta e está a saturar. Volta a gerar o áudio do(s) ' +
          'segmento(s) afetado(s).',
      };
    }
    return {
      name,
      passed: true,
      severity: 'error',
      details: `max peak level=${peak.toFixed(3)} (< ${QC_THRESHOLDS.maxClipPeakLevel})`,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      severity: 'error',
      details: `analysis failed: ${errText(err)}`,
      reasonPt: 'Não foi possível verificar distorção no áudio do vídeo.',
    };
  }
}

interface SegmentNarrationSpan {
  id: string;
  segStart: number;
  segEnd: number;
  /** Span onde a Spec prevê narração (tempos globais do vídeo). */
  narStart: number;
  narEnd: number;
  /** Pausas previstas ≥ unexpectedSilenceSec (tempos globais). */
  expectedGaps: Array<{ start: number; end: number }>;
}

/** Linha temporal de narração a partir das palavras reais do TTS. */
function narrationSpans(spec: Spec): SegmentNarrationSpan[] {
  const spans: SegmentNarrationSpan[] = [];
  let offset = 0;
  for (const segment of spec.segments) {
    const dur = segment.actualDurationSec ?? segment.targetDurationSec;
    const words = segment.tts?.words ?? [];
    let narStart = offset;
    let narEnd = offset + dur;
    const expectedGaps: Array<{ start: number; end: number }> = [];
    if (words.length > 0) {
      narStart = offset + words[0]!.start;
      narEnd = offset + words[words.length - 1]!.end;
      for (let i = 0; i < words.length - 1; i++) {
        const gap = words[i + 1]!.start - words[i]!.end;
        if (gap >= QC_THRESHOLDS.unexpectedSilenceSec) {
          expectedGaps.push({ start: offset + words[i]!.end, end: offset + words[i + 1]!.start });
        }
      }
    }
    spans.push({ id: segment.id, segStart: offset, segEnd: offset + dur, narStart, narEnd, expectedGaps });
    offset += dur;
  }
  return spans;
}

function checkNoUnexpectedSilence(
  spec: Spec,
  silenceWindows: SilenceWindow[],
  silenceError: string | null,
): QcCheckResult {
  const name: QcCheckName = 'no-unexpected-silence';
  try {
    if (silenceError) {
      return {
        name,
        passed: false,
        severity: 'error',
        details: `silencedetect failed: ${silenceError}`,
        reasonPt: 'Não foi possível verificar silêncios inesperados na narração.',
      };
    }
    const spans = narrationSpans(spec);
    const offenders: string[] = [];
    for (const w of silenceWindows) {
      const dur = w.end - w.start;
      if (dur <= QC_THRESHOLDS.unexpectedSilenceSec) continue;
      for (const span of spans) {
        const overlapStart = Math.max(w.start, span.narStart);
        const overlapEnd = Math.min(w.end, span.narEnd);
        const overlap = overlapEnd - overlapStart;
        if (overlap <= 0) continue;
        let explained = 0;
        for (const gap of span.expectedGaps) {
          explained += Math.max(
            0,
            Math.min(w.end, gap.end) - Math.max(w.start, gap.start),
          );
        }
        const unexplained = overlap - explained;
        // > 0.4 s de silêncio onde devia haver voz = buraco (glitch de TTS,
        // faixa mal misturada, segmento cortado).
        if (unexplained > 0.4) {
          offenders.push(
            `${span.id}: ${unexplained.toFixed(1)}s de silêncio aos ${w.start.toFixed(1)}s`,
          );
        }
      }
    }
    if (offenders.length > 0) {
      return {
        name,
        passed: false,
        severity: 'error',
        details: `unexpected silence: ${offenders.join('; ')}`,
        reasonPt:
          'Há silêncio onde a narração devia continuar (' +
          offenders.join('; ') +
          ') — indicia um corte ou glitch no áudio do TTS. ' +
          'Ouve o segmento e volta a gerar a voz se necessário.',
      };
    }
    return {
      name,
      passed: true,
      severity: 'error',
      details: `no silence > ${QC_THRESHOLDS.unexpectedSilenceSec}s inside narration spans`,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      severity: 'error',
      details: `analysis failed: ${errText(err)}`,
      reasonPt: 'Não foi possível verificar silêncios inesperados na narração.',
    };
  }
}

interface SliceVolumes {
  meanDb: number;
  maxDb: number;
}

function parseDb(value: string): number {
  if (value.trim() === '-inf') return Number.NEGATIVE_INFINITY;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

/** mean/max volume (dB) de um slice de áudio via volumedetect. */
function measureSliceVolumes(
  videoPath: string,
  startSec: number,
  durationSec: number,
): SliceVolumes | null {
  try {
    const log = runFfmpegAnalysis([
      '-ss',
      String(Math.max(0, startSec)),
      '-t',
      String(durationSec),
      '-i',
      videoPath,
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ]);
    const mean = log.match(/mean_volume:\s*(\S+)\s*dB/);
    const max = log.match(/max_volume:\s*(\S+)\s*dB/);
    if (!mean || !max) return null;
    return { meanDb: parseDb(mean[1]!), maxDb: parseDb(max[1]!) };
  } catch {
    return null;
  }
}

function checkNoAbruptCut(videoPath: string, spec: Spec): QcCheckResult {
  const name: QcCheckName = 'no-abrupt-cut';
  try {
    const win = QC_THRESHOLDS.abruptCutWindowSec;
    const hi = QC_THRESHOLDS.abruptCutHighDb;
    const lo = QC_THRESHOLDS.abruptCutLowDb;
    // Fronteiras internas entre segmentos (tempos globais).
    const boundaries: Array<{ at: number; between: string }> = [];
    let offset = 0;
    const segs = spec.segments;
    for (let i = 0; i < segs.length; i++) {
      const dur = segs[i]!.actualDurationSec ?? segs[i]!.targetDurationSec;
      if (i < segs.length - 1) {
        boundaries.push({ at: offset + dur, between: `${segs[i]!.id} → ${segs[i + 1]!.id}` });
      }
      offset += dur;
    }
    const warnings: string[] = [];
    for (const b of boundaries) {
      const before = measureSliceVolumes(videoPath, b.at - win, win);
      const after = measureSliceVolumes(videoPath, b.at, win);
      if (!before || !after) continue;
      if (before.maxDb >= hi && after.meanDb <= lo) {
        warnings.push(
          `possível corte abrupto no fim de ${b.between.split(' → ')[0]} ` +
            `(energia ${before.maxDb.toFixed(0)} dB cai para silêncio aos ${b.at.toFixed(1)}s)`,
        );
      } else if (before.meanDb <= lo && after.maxDb >= hi) {
        warnings.push(
          `possível entrada abrupta no início de ${b.between.split(' → ')[1]} ` +
            `(silêncio sobe para ${after.maxDb.toFixed(0)} dB aos ${b.at.toFixed(1)}s)`,
        );
      }
    }
    if (warnings.length > 0) {
      return {
        name,
        passed: true,
        severity: 'warning',
        details: `abrupt-cut warnings: ${warnings.join('; ')}`,
        warningPt:
          'Atenção: ' +
          warnings.join('; ') +
          '. Ouve a transição — pode ser um corte seco na montagem do áudio.',
      };
    }
    return {
      name,
      passed: true,
      severity: 'warning',
      details: `no abrupt energy cliffs at ${boundaries.length} segment boundaries`,
    };
  } catch (err) {
    // Um aviso que não se consegue medir não deve chumbar nada.
    return {
      name,
      passed: true,
      severity: 'warning',
      details: `analysis failed: ${errText(err)}`,
      warningPt: 'Não foi possível verificar cortes abruptos nas fronteiras dos segmentos.',
    };
  }
}

// ── Orquestração do QC ─────────────────────────────────────────────

export interface RunQcOptions {
  jobId: string;
  videoPath: string;
  spec: Spec;
  /** Caminho do captions.srt (omitido = check de legendas chumba). */
  captionPath?: string | undefined;
  /** TTS resolvido na Fase B (rastreabilidade no relatório). */
  tts?: { provider: string; voice: string; rate: number } | undefined;
}

/**
 * Corre os 9 checks de QC sobre o vídeo final. Nunca atira exceção por
 * causa do conteúdo: cada check falha de forma fechada e registada.
 * Atira apenas se o próprio ficheiro de vídeo não existir.
 */
export async function runQc(opts: RunQcOptions): Promise<QcReport> {
  if (!existsSync(opts.videoPath)) {
    throw new Error(`runQc: vídeo final em falta: ${opts.videoPath}`);
  }
  // Janelas de silêncio partilhadas (audio-present + unexpected-silence).
  // Se a deteção falhar, os checks dependentes chumbam de forma fechada.
  let silenceWindows: SilenceWindow[] = [];
  let silenceError: string | null = null;
  try {
    silenceWindows = detectSilenceWindows(opts.videoPath);
  } catch (err) {
    silenceError = errText(err);
  }
  const checks: QcCheckResult[] = [
    checkAudioPresent(opts.videoPath, silenceWindows, silenceError),
    checkDuration(opts.videoPath, opts.spec),
    checkCaptions(opts.captionPath, opts.spec),
    checkNoBlack(opts.videoPath),
    checkNoFreeze(opts.videoPath),
    checkLoudness(opts.videoPath),
    checkNoClipping(opts.videoPath),
    checkNoUnexpectedSilence(opts.spec, silenceWindows, silenceError),
    checkNoAbruptCut(opts.videoPath, opts.spec),
  ];
  const report: QcReport = {
    schema: 'shorts-forge/qc-report',
    version: 1,
    jobId: opts.jobId,
    videoPath: opts.videoPath,
    generatedAt: new Date().toISOString(),
    passed: checks.every((c) => c.passed),
    thresholds: { ...QC_THRESHOLDS },
    checks,
    segments: opts.spec.segments.map((s) => ({
      id: s.id,
      actualDurationSec: s.actualDurationSec ?? s.targetDurationSec,
      wordCount: s.tts?.words.length ?? 0,
      ...(s.tts?.audioPath ? { audioPath: s.tts.audioPath } : {}),
    })),
  };
  if (opts.captionPath) report.captionPath = opts.captionPath;
  if (opts.tts) report.tts = { ...opts.tts };
  return report;
}

/** Escreve o relatório em `<outDir>/qc-report.json` (e devolve o caminho). */
export function writeQcReport(outDir: string, report: QcReport): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, QC_REPORT_FILENAME);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

/** Lê um relatório de QC; null quando ainda não existe. */
export function readQcReport(outDir: string): QcReport | null {
  const path = join(outDir, QC_REPORT_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as QcReport;
  } catch {
    return null;
  }
}

/** Motivos do chumbo em pt-PT, prontos para `job.error` e para a UI. */
export function formatQcFailurePt(report: QcReport): string {
  const failed = report.checks.filter((c) => !c.passed && c.severity === 'error');
  const total = report.checks.filter((c) => c.severity === 'error').length;
  const bullets = failed.map((c) => `• ${c.reasonPt ?? c.details}`);
  return (
    `O vídeo não passou no controlo de qualidade ` +
    `(${failed.length} de ${total} verificações chumbaram):\n` +
    bullets.join('\n')
  );
}

/** Avisos (severity=warning) em pt-PT; null quando não há nenhum. */
export function formatQcWarningsPt(report: QcReport): string | null {
  const warnings = report.checks.filter(
    (c) => c.severity === 'warning' && c.warningPt,
  );
  if (warnings.length === 0) return null;
  return (
    `O controlo de qualidade passou com ${warnings.length} aviso(s):\n` +
    warnings.map((c) => `• ${c.warningPt}`).join('\n')
  );
}

/** Indica se ffmpeg+ffprobe estão disponíveis (para testes saltarem com graça). */
export function qcToolsAvailable(): boolean {
  return ffmpegAvailable();
}
