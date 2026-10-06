/**
 * Tests for qc.ts — the automatic quality-control stage (Phase 4).
 *
 * All checks are REAL: tiny fixtures are generated with FFmpeg in
 * `before()` (never committed as binaries) and every check runs
 * ffprobe/ffmpeg filters against them. Includes a deliberately broken
 * render (silent + black video) that MUST fail QC.
 *
 * Run: npm test (tsc → node --test dist/test)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Spec } from '@shorts-forge/shared';
import {
  runQc,
  writeCaptionsSrt,
  writeQcReport,
  readQcReport,
  countSrtWords,
  countSpecWords,
  formatQcFailurePt,
  formatQcWarningsPt,
  qcToolsAvailable,
  QC_THRESHOLDS,
  QC_CHECK_NAMES,
  QC_REPORT_FILENAME,
  QC_CAPTION_FILENAME,
  type QcReport,
} from '../src/qc.js';

const HAVE_TOOLS = qcToolsAvailable();

function ff(args: string[]): void {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-y', ...args], {
    timeout: 120_000,
    encoding: 'utf8',
  });
  if (res.error || res.status !== 0) {
    throw new Error(
      `ffmpeg fixture falhou: ${String(res.error ?? res.stderr ?? '').slice(-1500)}`,
    );
  }
}

/** Spec de teste: 2 segmentos, 4.0 s no total, 8 palavras TTS reais. */
function testSpec(opts: { seg2FirstWordStart?: number } = {}): Spec {
  const s2Start = opts.seg2FirstWordStart ?? 0.0;
  return {
    version: 1,
    title: 'Vídeo de teste QC',
    format: '9:16',
    language: 'pt-PT',
    segments: [
      {
        id: 'seg-01',
        narration: 'Olá mundo, isto é um teste.',
        visualKeywords: [],
        brollDescription: '',
        targetDurationSec: 2.0,
        tts: {
          audioPath: '/tmp/qc-mock-1.wav',
          words: [
            { word: 'Olá', start: 0.0, end: 0.4 },
            { word: 'mundo,', start: 0.4, end: 0.8 },
            { word: 'isto', start: 0.8, end: 1.1 },
            { word: 'é', start: 1.1, end: 1.25 },
            { word: 'um', start: 1.25, end: 1.4 },
            { word: 'teste.', start: 1.4, end: 1.75 },
          ],
          durationSec: 1.75,
        },
        actualDurationSec: 2.0,
      },
      {
        id: 'seg-02',
        narration: 'Segunda parte.',
        visualKeywords: [],
        brollDescription: '',
        targetDurationSec: 2.0,
        tts: {
          audioPath: '/tmp/qc-mock-2.wav',
          words: [
            { word: 'Segunda', start: s2Start, end: s2Start + 0.5 },
            { word: 'parte.', start: s2Start + 0.5, end: s2Start + 1.0 },
          ],
          durationSec: 1.0,
        },
        actualDurationSec: 2.0,
      },
    ],
  };
}

let dir = '';
const F = (name: string): string => join(dir, name);

before(() => {
  if (!HAVE_TOOLS) return;
  dir = mkdtempSync(join(tmpdir(), 'sf-qc-'));

  // Vídeo BOM: imagem animada + tom normalizado a −16 LUFS, 4.0 s.
  ff([
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-shortest',
    F('good.mp4'),
  ]);
  // Áudio em silêncio (imagem ok).
  ff([
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    F('bad-silent.mp4'),
  ]);
  // Sem faixa de áudio.
  ff([
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
    F('bad-noaudio.mp4'),
  ]);
  // Imagem preta 4 s (áudio ok).
  ff([
    '-f', 'lavfi', '-i', 'color=c=black:size=320x240:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    F('bad-black.mp4'),
  ]);
  // Imagem congelada 4 s (áudio ok).
  ff([
    '-f', 'lavfi', '-i', 'color=c=red:size=320x240:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    F('bad-frozen.mp4'),
  ]);
  // Demasiado alto: −9.7 LUFS medidos.
  ff([
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-af', 'volume=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    F('bad-loud.mp4'),
  ]);
  // Demasiado curto: 1.5 s contra 4.0 s esperados.
  ff([
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=1.5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    F('bad-short.mp4'),
  ]);
  // Render partido de propósito: silencioso + preto (o teste "e2e" do QC).
  ff([
    '-f', 'lavfi', '-i', 'color=c=black:size=320x240:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    F('bad-render.mp4'),
  ]);
  // Clipping: tom a volume 8 (distorção digital).
  ff([
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-af', 'volume=8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    F('bad-clip.mp4'),
  ]);
  // Buraco de 1.2 s a meio da narração do seg-01 (a Spec prevê voz contínua).
  ff([
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-af', "volume='if(lt(t,1.0),1,if(lt(t,2.2),0,1))':eval=frame,loudnorm=I=-16:TP=-1.5:LRA=11",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    F('bad-gap.mp4'),
  ]);
  // Corte seco de 0.15 s mesmo na fronteira seg-01 → seg-02 (t=2.0).
  ff([
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-af', "volume='if(lt(t,1.95),1,if(lt(t,2.1),0,1))':eval=frame,loudnorm=I=-16:TP=-1.5:LRA=11",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    F('bad-cut.mp4'),
  ]);

  // Legendas boas para a Spec de teste (8 palavras).
  writeCaptionsSrt(testSpec(), F(QC_CAPTION_FILENAME));
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function check(report: QcReport, name: string) {
  const c = report.checks.find((x) => x.name === name);
  assert.ok(c, `check "${name}" existe no relatório`);
  return c;
}

describe('qc — limiares documentados', () => {
  it('limiares têm os valores decididos (ARCHITECTURE.md §8.3)', () => {
    assert.equal(QC_THRESHOLDS.durationToleranceSec, 1.5);
    assert.equal(QC_THRESHOLDS.durationToleranceRatio, 0.05);
    assert.equal(QC_THRESHOLDS.maxBlackSec, 1.0);
    assert.equal(QC_THRESHOLDS.maxFreezeSec, 1.0);
    assert.equal(QC_THRESHOLDS.loudnessTargetLufs, -16);
    assert.equal(QC_THRESHOLDS.loudnessToleranceLufs, 2);
    assert.equal(QC_THRESHOLDS.minNonSilentSec, 1.0);
    assert.equal(QC_THRESHOLDS.captionWordTolerance, 5);
    assert.equal(QC_THRESHOLDS.maxClipPeakLevel, 1.0);
    assert.equal(QC_THRESHOLDS.unexpectedSilenceSec, 0.8);
    assert.equal(QC_THRESHOLDS.abruptCutWindowSec, 0.1);
    assert.equal(QC_THRESHOLDS.abruptCutHighDb, -20);
    assert.equal(QC_THRESHOLDS.abruptCutLowDb, -45);
    assert.deepEqual([...QC_CHECK_NAMES], [
      'audio-present',
      'duration',
      'captions',
      'no-black',
      'no-freeze',
      'loudness',
      'no-clipping',
      'no-unexpected-silence',
      'no-abrupt-cut',
    ]);
  });

  it('writeCaptionsSrt conta as mesmas palavras da Spec', { skip: !HAVE_TOOLS }, () => {
    const srt = F('captions-check.srt');
    writeCaptionsSrt(testSpec(), srt);
    assert.equal(countSpecWords(testSpec()), 8);
    assert.equal(countSrtWords(srt), 8);
  });
});

describe('qc — checks individuais', { skip: !HAVE_TOOLS }, () => {
  it('vídeo bom passa nos 9 checks, sem avisos', async () => {
    const report = await runQc({
      jobId: 'job-test',
      videoPath: F('good.mp4'),
      spec: testSpec(),
      captionPath: F(QC_CAPTION_FILENAME),
      tts: { provider: 'kokoro', voice: 'pf_dora', rate: 1 },
    });
    assert.equal(report.passed, true);
    assert.equal(report.checks.length, 9);
    for (const c of report.checks) {
      assert.equal(c.passed, true, `check "${c.name}" devia passar: ${c.details}`);
      assert.equal(c.warningPt, undefined, `check "${c.name}" não devia ter avisos`);
    }
    assert.equal(report.schema, 'shorts-forge/qc-report');
    assert.equal(report.version, 1);
    assert.deepEqual(report.thresholds, { ...QC_THRESHOLDS });
    // Rastreabilidade do TTS.
    assert.deepEqual(report.tts, { provider: 'kokoro', voice: 'pf_dora', rate: 1 });
    assert.equal(report.segments.length, 2);
    assert.equal(report.segments[0]!.id, 'seg-01');
    assert.equal(report.segments[0]!.wordCount, 6);
    assert.equal(report.segments[1]!.wordCount, 2);
    assert.equal(formatQcWarningsPt(report), null);
  });

  it('áudio silencioso chumba audio-present', async () => {
    const report = await runQc({
      jobId: 'job-test',
      videoPath: F('bad-silent.mp4'),
      spec: testSpec(),
      captionPath: F(QC_CAPTION_FILENAME),
    });
    assert.equal(report.passed, false);
    const c = check(report, 'audio-present');
    assert.equal(c.passed, false);
    assert.match(c.reasonPt ?? '', /silêncio/);
  });

  it('sem faixa de áudio chumba audio-present', async () => {
    const report = await runQc({
      jobId: 'job-test',
      videoPath: F('bad-noaudio.mp4'),
      spec: testSpec(),
      captionPath: F(QC_CAPTION_FILENAME),
    });
    const c = check(report, 'audio-present');
    assert.equal(c.passed, false);
    assert.match(c.reasonPt ?? '', /não tem faixa de áudio/);
  });

  it('duração fora da tolerância chumba duration', async () => {
    const report = await runQc({
      jobId: 'job-test',
      videoPath: F('bad-short.mp4'),
      spec: testSpec(),
      captionPath: F(QC_CAPTION_FILENAME),
    });
    const c = check(report, 'duration');
    assert.equal(c.passed, false);
    assert.match(c.details, /diff=2\.50s/);
    assert.match(c.reasonPt ?? '', /desvia-se/);
  });

  it('legendas em falta chumbam captions', async () => {
    const report = await runQc({
      jobId: 'job-test',
      videoPath: F('good.mp4'),
      spec: testSpec(),
      captionPath: F('nao-existe.srt'),
    });
    const c = check(report, 'captions');
    assert.equal(c.passed, false);
    assert.match(c.reasonPt ?? '', /legendas/i);
  });

  it('palavras das legendas inconsistentes chumbam captions', async () => {
    const srt = F('captions-curto.srt');
    // Legenda com 1 palavra contra 8 narradas (diff 7 > tolerância de 5).
    const tiny = testSpec().segments[0]!;
    writeCaptionsSrt(
      {
        ...testSpec(),
        segments: [
          {
            ...tiny,
            tts: {
              audioPath: tiny.tts!.audioPath,
              words: [{ word: 'Olá', start: 0, end: 0.4 }],
              durationSec: 0.4,
            },
          },
        ],
      },
      srt,
    );
    const report = await runQc({
      jobId: 'job-test',
      videoPath: F('good.mp4'),
      spec: testSpec(),
      captionPath: srt,
    });
    const c = check(report, 'captions');
    assert.equal(c.passed, false);
    assert.match(c.reasonPt ?? '', /palavras/);
  });

  it('imagem preta contínua chumba no-black', async () => {
    const report = await runQc({
      jobId: 'job-test',
      videoPath: F('bad-black.mp4'),
      spec: testSpec(),
      captionPath: F(QC_CAPTION_FILENAME),
    });
    const c = check(report, 'no-black');
    assert.equal(c.passed, false);
    assert.match(c.reasonPt ?? '', /preta/);
  });

  it('imagem congelada chumba no-freeze', async () => {
    const report = await runQc({
      jobId: 'job-test',
      videoPath: F('bad-frozen.mp4'),
      spec: testSpec(),
      captionPath: F(QC_CAPTION_FILENAME),
    });
    const c = check(report, 'no-freeze');
    assert.equal(c.passed, false);
    assert.match(c.reasonPt ?? '', /parada/);
  });

  it('loudness fora do alvo chumba loudness', async () => {
    const report = await runQc({
      jobId: 'job-test',
      videoPath: F('bad-loud.mp4'),
      spec: testSpec(),
      captionPath: F(QC_CAPTION_FILENAME),
    });
    const c = check(report, 'loudness');
    assert.equal(c.passed, false);
    assert.match(c.details, /integrated=-9/);
    assert.match(c.reasonPt ?? '', /LUFS/);
  });

  it('clipping (distorção) chumba no-clipping', async () => {
    const report = await runQc({
      jobId: 'job-test',
      videoPath: F('bad-clip.mp4'),
      spec: testSpec(),
      captionPath: F(QC_CAPTION_FILENAME),
    });
    const c = check(report, 'no-clipping');
    assert.equal(c.passed, false);
    assert.equal(c.severity, 'error');
    assert.match(c.details, /max peak level=1/);
    assert.match(c.reasonPt ?? '', /distorção/);
  });

  it('silêncio inesperado a meio da narração chumba no-unexpected-silence', async () => {
    const report = await runQc({
      jobId: 'job-test',
      videoPath: F('bad-gap.mp4'),
      spec: testSpec(),
      captionPath: F(QC_CAPTION_FILENAME),
    });
    const c = check(report, 'no-unexpected-silence');
    assert.equal(c.passed, false);
    assert.equal(c.severity, 'error');
    assert.match(c.details, /seg-01/);
    assert.match(c.reasonPt ?? '', /silêncio/);
    // O áudio global continua "presente" — o buraco é localizado.
    assert.equal(check(report, 'audio-present').passed, true);
  });

  it('corte abrupto na fronteira gera AVISO (não chumba o QC)', async () => {
    const spec = testSpec({ seg2FirstWordStart: 0.15 });
    const srt = F('captions-cut.srt');
    writeCaptionsSrt(spec, srt);
    const report = await runQc({
      jobId: 'job-test',
      videoPath: F('bad-cut.mp4'),
      spec,
      captionPath: srt,
    });
    const c = check(report, 'no-abrupt-cut');
    assert.equal(c.passed, true, 'aviso nunca chumba');
    assert.equal(c.severity, 'warning');
    assert.ok(c.warningPt, 'há warningPt em pt-PT');
    assert.match(c.warningPt ?? '', /corte abrupto/);
    // Todo o resto passa — o relatório global passa com aviso.
    assert.equal(report.passed, true);
    const warnings = formatQcWarningsPt(report);
    assert.ok(warnings);
    assert.match(warnings, /aviso/);
    assert.match(warnings, /corte abrupto/);
    // O buraco de 0.15 s está abaixo do limiar de silêncio inesperado.
    assert.equal(check(report, 'no-unexpected-silence').passed, true);
  });
});

describe('qc — render partido falha o QC (e2e)', { skip: !HAVE_TOOLS }, () => {
  it('render silencioso+preto → relatório chumbado, motivos em pt-PT', async () => {
    const report = await runQc({
      jobId: 'job-partido',
      videoPath: F('bad-render.mp4'),
      spec: testSpec(),
      captionPath: F(QC_CAPTION_FILENAME),
    });
    assert.equal(report.passed, false);
    assert.equal(check(report, 'audio-present').passed, false);
    assert.equal(check(report, 'no-black').passed, false);

    const reasons = formatQcFailurePt(report);
    assert.match(reasons, /não passou no controlo de qualidade/);
    assert.match(reasons, /silêncio/);
    assert.match(reasons, /preta/);

    const reportPath = writeQcReport(dir, report);
    assert.equal(reportPath, join(dir, QC_REPORT_FILENAME));
    assert.ok(existsSync(reportPath), 'qc-report.json foi escrito');
    const back = readQcReport(dir);
    assert.ok(back);
    assert.equal(back.passed, false);
    assert.equal(back.jobId, 'job-partido');
    assert.equal(back.checks.length, 9);
  });

  it('runQc com vídeo em falta atira erro honesto (nada é inventado)', async () => {
    await assert.rejects(
      () =>
        runQc({
          jobId: 'job-x',
          videoPath: F('nao-existe.mp4'),
          spec: testSpec(),
        }),
      /em falta/,
    );
  });
});
