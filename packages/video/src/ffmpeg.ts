/**
 * FFmpeg final assembly.
 *
 * REAL: detectHwAccel() probes the installed FFmpeg for hardware H.264
 * encoders; buildAssembleArgs() is a pure function that builds the full
 * ffmpeg command line for the final assembly:
 *   - scale/crop every rendered segment clip to the target canvas,
 *   - concat segments in order,
 *   - duck background music under narration (sidechaincompress),
 *   - loudness-normalize the master (loudnorm),
 *   - encode H.264 (hwaccel when available) + AAC.
 *
 * REAL: assemble() spawns FFmpeg with buildAssembleArgs(); assembleJob()
 * is the Phase B entry point — it takes the re-timed segments plus the
 * rendered per-segment clips, normalizes/pads each TTS narration track to
 * its segment's real duration, and produces outputs/final.mp4.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import type { Segment, VideoFormat } from '@shorts-forge/shared';

/** Hardware acceleration backends, in probe priority order. */
export type HwAccel = 'nvenc' | 'videotoolbox' | 'qsv' | 'none';

const ENCODER_BY_ACCEL: Record<HwAccel, string> = {
  nvenc: 'h264_nvenc',
  videotoolbox: 'h264_videotoolbox',
  qsv: 'h264_qsv',
  none: 'libx264',
};

function encoderAvailable(encoderName: string): boolean {
  try {
    const res = spawnSync('ffmpeg', ['-hide_banner', '-h', `encoder=${encoderName}`], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    return res.status === 0 && String(res.stdout ?? '').includes(encoderName);
  } catch {
    return false;
  }
}

/**
 * Actually encodes one tiny frame with the encoder: the `-h encoder=`
 * probe above only proves the encoder is compiled in, not that a GPU is
 * usable (headless VMs often list nvenc but fail at init).
 */
function encoderUsable(encoderName: string): boolean {
  try {
    const res = spawnSync(
      'ffmpeg',
      [
        '-hide_banner', '-y',
        '-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.1:r=30',
        '-c:v', encoderName,
        '-f', 'null', '-',
      ],
      { timeout: 30_000, encoding: 'utf8' },
    );
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Probes the local FFmpeg for hardware H.264 encoders.
 * Never throws: any probe failure degrades to 'none' (software libx264).
 * The probe encodes a real (tiny) frame, so an encoder is only reported
 * when it actually works on this machine — not merely compiled in.
 */
export function detectHwAccel(): HwAccel {
  const probes: [HwAccel, string][] = [
    ['nvenc', 'h264_nvenc'],
    ['videotoolbox', 'h264_videotoolbox'],
    ['qsv', 'h264_qsv'],
  ];
  for (const [accel, encoder] of probes) {
    if (encoderAvailable(encoder) && encoderUsable(encoder)) return accel;
  }
  return 'none';
}

export interface AssembleOptions {
  /** Rendered per-segment video clips, in order (from the Hyperframes adapter). */
  segmentClips: string[];
  /** Per-segment narration audio tracks (TTS), in order. */
  narrationTracks: string[];
  /** Optional background music track (ducked under narration). */
  musicPath?: string | undefined;
  /** Final output path (e.g. outputs/final.mp4). */
  outPath: string;
  format: VideoFormat;
  hwAccel: HwAccel;
  /** Output frame rate. Default 30. */
  fps?: number | undefined;
  /** CRF for software (libx264) encoding. Default 20. */
  crf?: number | undefined;
  /** Music level before ducking (0-1). Default 0.12. */
  musicLevel?: number | undefined;
  /** Timeout for the FFmpeg process in ms. Default 30 minutes. */
  timeoutMs?: number | undefined;
}

/**
 * Builds the ffmpeg argv for the final assembly. Pure — no process is
 * spawned. Layout of inputs: [segmentClips..., narrationTracks...,
 * music?]. Audio chain: narration concat → (music sidechain-ducked) →
 * amix → loudnorm. Video chain: scale/crop → concat.
 */
export function buildAssembleArgs(opts: AssembleOptions): string[] {
  if (opts.segmentClips.length === 0) {
    throw new Error('buildAssembleArgs: é necessário pelo menos um clip de segmento.');
  }
  const fps = opts.fps ?? 30;
  const [W, H] = opts.format === '9:16' ? [1080, 1920] : [1920, 1080];

  const args: string[] = ['-hide_banner', '-y'];
  for (const c of opts.segmentClips) args.push('-i', c);
  for (const n of opts.narrationTracks) args.push('-i', n);
  let musicIdx = -1;
  if (opts.musicPath) {
    musicIdx = opts.segmentClips.length + opts.narrationTracks.length;
    args.push('-i', opts.musicPath);
  }

  const filters: string[] = [];

  // Video: normalize every segment to the target canvas, then concat.
  const vLabels: string[] = [];
  opts.segmentClips.forEach((_, i) => {
    filters.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H},setsar=1,fps=${fps}[v${i}]`,
    );
    vLabels.push(`[v${i}]`);
  });
  filters.push(`${vLabels.join('')}concat=n=${opts.segmentClips.length}:v=1:a=0[vcat]`);

  // Audio: concat narration tracks.
  let masterAudio: string | null = null;
  const nStart = opts.segmentClips.length;
  if (opts.narrationTracks.length > 0) {
    const aLabels = opts.narrationTracks.map((_, j) => `[${nStart + j}:a]`).join('');
    if (opts.narrationTracks.length === 1) {
      filters.push(`${aLabels}anull[ncat]`);
    } else {
      filters.push(
        `${aLabels}concat=n=${opts.narrationTracks.length}:v=0:a=1[ncat]`,
      );
    }
    if (musicIdx >= 0) {
      const level = opts.musicLevel ?? 0.12;
      filters.push(`[${musicIdx}:a]volume=${level},apad[mus]`);
      filters.push(
        `[mus][ncat]sidechaincompress=threshold=0.02:ratio=8:attack=200:release=500[duck]`,
      );
      filters.push(`[ncat][duck]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
    } else {
      filters.push(`[ncat]anull[aout]`);
    }
    filters.push(`[aout]loudnorm=I=-16:TP=-1.5:LRA=11[aoutn]`);
    masterAudio = '[aoutn]';
  } else if (musicIdx >= 0) {
    filters.push(`[${musicIdx}:a]volume=0.5,apad,loudnorm=I=-16:TP=-1.5:LRA=11[aoutn]`);
    masterAudio = '[aoutn]';
  }

  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[vcat]');
  if (masterAudio) args.push('-map', masterAudio);

  const encoder = ENCODER_BY_ACCEL[opts.hwAccel];
  args.push('-c:v', encoder);
  if (encoder === 'libx264') {
    args.push('-preset', 'medium', '-crf', String(opts.crf ?? 20));
  }
  args.push('-pix_fmt', 'yuv420p', '-r', String(fps));
  if (masterAudio) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  }
  args.push('-shortest', opts.outPath);
  return args;
}

/**
 * Executes the final FFmpeg assembly: spawns FFmpeg with
 * buildAssembleArgs() and verifies the output file.
 *
 * Pre-flight (honest failures, in pt-PT): every segment clip and every
 * narration track must exist on disk — nothing is faked. Returns the
 * absolute outPath.
 */
export async function assemble(opts: AssembleOptions): Promise<string> {
  if (opts.segmentClips.length === 0) {
    throw new Error('assemble: é necessário pelo menos um clip de segmento.');
  }
  for (const clip of opts.segmentClips) {
    if (!existsSync(clip)) {
      throw new Error(`assemble: clip de segmento em falta: ${clip}`);
    }
  }
  for (const track of opts.narrationTracks) {
    if (!existsSync(track)) {
      throw new Error(`assemble: faixa de narração em falta: ${track}`);
    }
  }
  if (opts.musicPath && !existsSync(opts.musicPath)) {
    throw new Error(`assemble: faixa de música em falta: ${opts.musicPath}`);
  }

  const outPath = resolve(opts.outPath);
  mkdirSync(dirname(outPath), { recursive: true });

  const args = buildAssembleArgs({ ...opts, outPath });
  const timeout = opts.timeoutMs ?? 30 * 60 * 1000;
  const res = spawnSync('ffmpeg', args, { timeout, encoding: 'utf8' });
  if (res.error) {
    throw new Error(`assemble: falha ao executar o FFmpeg: ${String(res.error)}`);
  }
  if (res.status !== 0 || !existsSync(outPath)) {
    const tail = String(res.stderr ?? '').slice(-4000);
    throw new Error(`assemble: o FFmpeg falhou (exit ${res.status}). ${tail}`);
  }
  return outPath;
}

export interface AssembleJobInput {
  /** Re-timed segments (actualDurationSec + tts + broll filled in). */
  segments: Segment[];
  /** Rendered per-segment MP4 clips, in the same order as `segments`. */
  segmentClips: string[];
  /** Base outputs dir; the final MP4 lands at `<outDir>/final.mp4`. */
  outDir: string;
  format: VideoFormat;
  /** Optional background music track (ducked under narration). */
  musicPath?: string | undefined;
  /** Output frame rate. Default 30. */
  fps?: number | undefined;
  /** CRF for software (libx264) encoding. Default 20. */
  crf?: number | undefined;
  /** Music level before ducking (0-1). Default 0.12. */
  musicLevel?: number | undefined;
  /** Hardware encoder. Default: detectHwAccel(). */
  hwAccel?: HwAccel | undefined;
  /** Timeout for the FFmpeg process in ms. Default 30 minutes. */
  timeoutMs?: number | undefined;
  /** Progress notes (audio prep, muxing). */
  onProgress?: ((message: string) => void) | undefined;
}

/**
 * Normalizes one narration track: resample to 48 kHz stereo and pad/trim
 * to EXACTLY `targetDurationSec`. This keeps the audio timeline sample-
 * aligned with the video timeline (each segment clip is
 * `actualDurationSec` long), so the final `-shortest` never trims the
 * video's breathing margins. Returns the padded WAV path.
 */
function normalizeNarrationTrack(
  srcPath: string,
  targetDurationSec: number,
  outPath: string,
): string {
  mkdirSync(dirname(outPath), { recursive: true });
  const filter =
    `aresample=48000,aformat=channel_layouts=stereo,` +
    `apad=whole_dur=${targetDurationSec},atrim=0:${targetDurationSec}`;
  const res = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-y', '-i', srcPath, '-af', filter, '-c:a', 'pcm_s16le', outPath],
    { timeout: 5 * 60 * 1000, encoding: 'utf8' },
  );
  if (res.error || res.status !== 0 || !existsSync(outPath)) {
    const tail = String(res?.stderr ?? res?.error ?? '').slice(-2000);
    throw new Error(
      `assembleJob: falha a normalizar a narração "${srcPath}" para ${targetDurationSec}s. ${tail}`,
    );
  }
  return outPath;
}

/**
 * Phase B assembly entry point: takes the re-timed segments, the rendered
 * per-segment clips and the TTS audio, and composes the final timeline
 * with buildAssembleArgs(). Output: `<outDir>/final.mp4` (absolute path
 * returned).
 *
 * Honest pre-flight: segment/clip counts must match, and every segment
 * must carry its real TTS audio (`segment.tts.audioPath`, on disk).
 * B-roll is already baked into the segment clips by the Hyperframes
 * render — `segment.broll` is informational here (kept on the type for
 * the QC/reporting stages).
 */
export async function assembleJob(input: AssembleJobInput): Promise<string> {
  const { segments, segmentClips } = input;
  if (segments.length === 0) {
    throw new Error('assembleJob: sem segmentos para montar.');
  }
  if (segmentClips.length !== segments.length) {
    throw new Error(
      `assembleJob: ${segmentClips.length} clips para ${segments.length} segmentos — têm de coincidir por ordem.`,
    );
  }

  const outDir = resolve(input.outDir);
  mkdirSync(outDir, { recursive: true });
  const audioDir = join(outDir, '.audio');
  mkdirSync(audioDir, { recursive: true });

  // Narration tracks: real TTS audio per segment, normalized to the real
  // segment duration. A missing tts entry is a hard, explicit failure —
  // never silence, never a guessed duration.
  const narrationTracks: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const audioPath = segment.tts?.audioPath;
    if (!audioPath || !existsSync(audioPath)) {
      throw new Error(
        `assembleJob: o segmento "${segment.id}" não tem áudio TTS válido ` +
          `(segment.tts.audioPath em falta ou ficheiro inexistente).`,
      );
    }
    const durationSec = segment.actualDurationSec ?? segment.targetDurationSec;
    input.onProgress?.(
      `A preparar o áudio do segmento ${i + 1}/${segments.length} (${segment.id})…`,
    );
    narrationTracks.push(
      normalizeNarrationTrack(audioPath, durationSec, join(audioDir, `${segment.id}.wav`)),
    );
  }

  input.onProgress?.('A compor a timeline final (FFmpeg)…');
  return assemble({
    segmentClips,
    narrationTracks,
    outPath: join(outDir, 'final.mp4'),
    format: input.format,
    hwAccel: input.hwAccel ?? detectHwAccel(),
    fps: input.fps,
    crf: input.crf,
    musicLevel: input.musicLevel,
    timeoutMs: input.timeoutMs,
    ...(input.musicPath ? { musicPath: input.musicPath } : {}),
  });
}
