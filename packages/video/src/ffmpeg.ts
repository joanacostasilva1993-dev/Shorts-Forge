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
 * STUB: assemble() — executing the real assembly needs rendered segment
 * clips, which only exist in Phase 4. It throws unmistakably.
 */
import { spawnSync } from 'node:child_process';
import type { VideoFormat } from '@shorts-forge/shared';

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
 * Probes the local FFmpeg for hardware H.264 encoders.
 * Never throws: any probe failure degrades to 'none' (software libx264).
 */
export function detectHwAccel(): HwAccel {
  const probes: [HwAccel, string][] = [
    ['nvenc', 'h264_nvenc'],
    ['videotoolbox', 'h264_videotoolbox'],
    ['qsv', 'h264_qsv'],
  ];
  for (const [accel, encoder] of probes) {
    if (encoderAvailable(encoder)) return accel;
  }
  return 'none';
}

export interface AssembleOptions {
  /** Rendered per-segment video clips, in order (from the Hyperframes adapter). */
  segmentClips: string[];
  /** Per-segment narration audio tracks (TTS), in order. */
  narrationTracks: string[];
  /** Optional background music track (ducked under narration). */
  musicPath?: string;
  /** Final output path (e.g. outputs/final.mp4). */
  outPath: string;
  format: VideoFormat;
  hwAccel: HwAccel;
  /** Output frame rate. Default 30. */
  fps?: number;
  /** CRF for software (libx264) encoding. Default 20. */
  crf?: number;
  /** Music level before ducking (0-1). Default 0.12. */
  musicLevel?: number;
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
 * STUB — executes the final FFmpeg assembly.
 *
 * Blocked on Phase 4: it needs the real rendered segment clips
 * (Hyperframes output) and TTS narration tracks. Throws unmistakably.
 */
export async function assemble(_opts: AssembleOptions): Promise<string> {
  throw new Error(
    'STUB — montagem FFmpeg na Fase 4: precisa dos clips de segmento renderizados e das faixas de narração reais.',
  );
}
