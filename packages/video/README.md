# @shorts-forge/video

Renderização de vídeo do **shorts-forge**: templates de marca, legendas
karaoke a partir de timestamps reais de palavras (TTS), composição de
frames via Hyperframes e montagem final com FFmpeg.

> Regra central: **cada palavra é destacada exatamente quando é dita**,
> com base nos timestamps reais do TTS. Nada aqui inventa temporização.

## O que é real e o que é stub

| Módulo | Estado | Notas |
|---|---|---|
| `templates.ts` | ✅ Real | 3 templates como dados; `getTemplate` lança erro em id desconhecido |
| `captions.ts` | ✅ Real + testes | `buildCues`, `activeCue`, `renderCaptionHtml` (determinístico, com escape de HTML) |
| `frames.ts` | ✅ Real | `buildFrames`: 1 `FrameDescriptor` por segmento; duração = `actualDurationSec ?? targetDurationSec` |
| `hyperframesAdapter.ts` | ✅ Real (verificado) | Gera composição Hyperframes e invoca o CLI `render`; composição validada com `hyperframes lint` (0 erros) e **render real executado e confirmado por frames extraídos** |
| `preview.ts` | ✅ Real + testes | `writePreviewHtml` escreve HTML autónomo com cartões por segmento |
| `ffmpeg.ts` (`detectHwAccel`, `buildAssembleArgs`) | ✅ Real + testes | Deteção de NVENC/VideoToolbox/QSV; construtor puro de argumentos FFmpeg |
| `ffmpeg.ts` (`assemble`) | ⚠️ STUB | Lança `Error('STUB — …')`; precisa dos clips reais da Fase 4 |

## Templates (`templates.ts`)

```ts
import { getTemplate, listTemplateIds } from '@shorts-forge/video';

const t = getTemplate('bold-social'); // 'minimal' | 'cinematic'
```

- **Social Intenso** (`bold-social`): tipografia pesada, contorno de alto
  contraste, acentos vibrantes. Legendas centradas.
- **Minimalista** (`minimal`): sans limpa, legendas discretas no terço inferior.
- **Cinematográfico** (`cinematic`): serifa elegante, legendas suaves no
  terço inferior (a pensar em barras de cinema).

`BrandTemplate = { id, name, description, colors: {bg, fg, accent, highlight},
fontStack, caption: { fontSizePx, strokePx, position } }`.

## Legendas karaoke (`captions.ts`)

```ts
import { buildCues, activeCue, renderCaptionHtml } from '@shorts-forge/video';

const cues = buildCues(segment.tts.words); // remove palavras com duração zero
const i = activeCue(cues, t);              // índice com start <= t < end, ou -1
const html = renderCaptionHtml(cues, t, template);
```

- `renderCaptionHtml` devolve um `<span class="w …">` por palavra, cada um
  com os atributos `data-start`/`data-duration` reais. Classes: `active`
  (a palavra dita em `t`), `upcoming` (palavras que ainda vão ser ditas),
  sem classe (palavras já ditas). O HTML das palavras é escapado.
- `renderCaptionHtmlWithActive(cues, index, template)` escolhe a palavra
  ativa por índice (usado pelo adaptador Hyperframes para gerar uma
  camada de destaque por palavra).
- `parseCueTimings` / `parseCaptionWords` recuperam palavras + tempos a
  partir desse HTML (round-trip testado).

## Frames (`frames.ts`)

```ts
import { buildFrames } from '@shorts-forge/video';

const { frames, template, totalDurationSec } = buildFrames(spec, 'minimal');
// frames[i]: { segmentId, durationSec, background, captionHtmlAt }
```

- `background`: `{ kind: 'broll', url }` quando o segmento tem B-roll
  resolvido; senão `{ kind: 'color', color }` com a cor do template.
- `captionHtmlAt(t)` recebe `t` em segundos **relativos ao início do
  segmento**. Puro e agnóstico do renderizador — a interface
  `FrameDescriptor` é final.

## Adaptador Hyperframes (`hyperframesAdapter.ts`) — real

O pacote `hyperframes` (npm, v0.8.134, Apache-2.0) não expõe API
programática — é um CLI. O adaptador:

1. `buildCompositionHtml(frames, template, { width, height, fps })` (pura,
   testada) gera uma composição HTML autónoma:
   - raiz com `data-composition-id`, `data-start="0"`, `data-duration`
     (soma real), `data-width/height/fps` e `data-no-timeline` (sem
     JavaScript de animação — só clips temporizados);
   - um `.clip` de cena por segmento (`data-start`/`data-duration`
     absolutos na timeline);
   - **karaoke determinístico**: por cada palavra, um `.clip` irmão
     (flat, nunca aninhado) com `[start, end)` reais, contendo a mesma
     caixa de legenda com só essa palavra em destaque — o destaque cai
     sempre no pixel certo, sem JavaScript de temporização.
2. `renderFrames(frames, { width, height, outPath, template?, fps?, workDir?, timeoutMs? })`
   escreve a composição e invoca o CLI (`render -c composition.html -o …`),
   resolvendo o binário do pacote instalado (sem depender de `npx`/PATH).
   Devolve `outPath`.
3. `lintCompositionHtml(html, workDir?)` valida com `hyperframes lint`.

Pré-requisitos na máquina de render: `npx hyperframes browser ensure`
(saca o Chromium na primeira utilização) e `TMPDIR` a apontar para um
disco com espaço (o CLI verifica espaço livre em `os.tmpdir()`; em
contentores `/tmp` pode ser um tmpfs pequeno).

## Preview (`preview.ts`)

```ts
import { writePreviewHtml } from '@shorts-forge/video';

writePreviewHtml(spec, 'cinematic', 'outputs/preview.html'); // devolve o caminho
```

HTML autónomo com um cartão por segmento: id, narração, temporização
(`início → fim` no vídeo) e legenda estática com o estilo do template.
Para revisão humana antes do render final.

## Montagem FFmpeg (`ffmpeg.ts`)

```ts
import { detectHwAccel, buildAssembleArgs } from '@shorts-forge/video';

const hw = detectHwAccel(); // 'nvenc' | 'videotoolbox' | 'qsv' | 'none'
const args = buildAssembleArgs({
  segmentClips: ['seg-01.mp4', 'seg-02.mp4'], // saída do adaptador Hyperframes
  narrationTracks: ['narr-01.wav', 'narr-02.wav'], // TTS por segmento
  musicPath: 'musica.mp3',                        // opcional
  outPath: 'outputs/final.mp4',
  format: '9:16',
  hwAccel: hw,
});
```

Desenho da montagem (filter_complex):

- **Vídeo**: cada clip é normalizado para o canvas
  (`scale=1080:1920` + `crop` para 9:16; `1920:1080` para 16:9) e os
  segmentos são concatenados por ordem.
- **Áudio**: faixas de narração concatenadas; com música, esta é atenuada
  (`volume=0.12`) e sofre *ducking* sob a narração
  (`sidechaincompress`), misturada (`amix`) e o master é normalizado com
  `loudnorm` (I=-16, TP=-1.5, LRA=11).
- **Codificação**: `h264_nvenc` / `h264_videotoolbox` / `h264_qsv` /
  `libx264` conforme `hwAccel`; `yuv420p`; áudio `aac` 192k.

`assemble()` é **stub intencional**: só pode executar na Fase 4, quando
existirem os clips de segmento renderizados e as faixas de narração.

## Desenvolver

```bash
npm run build      # tsc
npm run typecheck  # tsc --noEmit
npm test           # tsc + node --test (32 testes, verdes)
```

## Para a Fase 3/4

- **Fase 3 (pipeline)**: chamar `buildFrames(spec, templateId)` após a
  re-temporização, depois `renderFrames(frames, …)` por segmento (ou
  compor a timeline toda numa composição e fatiar); usar
  `lintCompositionHtml` como gate antes de renders caros; expor
  `writePreviewHtml` no passo de preview da UI.
- **Fase 4 (montagem)**: implementar `assemble()` — é só `spawn` do
  FFmpeg com `buildAssembleArgs(...)`; os testes do construtor de
  argumentos já cobrem sidechaincompress, loudnorm, encoder por hwaccel
  e canvas por formato.
- **B-roll em vídeo**: o adaptador já emite `<video>` para URLs `.mp4`/
  `.webm`/`.mov`; validar com um clip real (o teste usou imagem/fallback
  de cor).
