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
| `ffmpeg.ts` (`detectHwAccel`, `buildAssembleArgs`) | ✅ Real + testes | Deteção de NVENC/VideoToolbox/QSV **com probe real de encode** (só reporta o que funciona); construtor puro de argumentos FFmpeg |
| `ffmpeg.ts` (`assemble`, `assembleJob`) | ✅ Real + testes | `assemble` executa o FFmpeg com `buildAssembleArgs()`; `assembleJob` é a entrada da Fase B (segmentos re-temporizados + clips + áudio TTS → `final.mp4`, com normalização/pad do áudio por segmento) |
| `render.ts` | ✅ Real + testes | `buildSegmentFrame` → `buildSegmentComposition` → gate `lintCompositionHtml` → `renderFrames`: 1 clip MP4 por segmento; `renderJobSegments`, `renderPreviewMp4` (preview leve 360x640) e `renderJobVideo` (segmentos + `assembleJob`) |
| `broll.ts` | ✅ Real + testes | `resolveBroll`/`resolveBrollForSegments`: cascata Pexels → Pixabay → Ken Burns → fundo de template; registo no-repeat; cache em `outputs/cache/broll/` |

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
  `libx264` conforme `hwAccel` (só aceleradores que passam num probe de
  encode real); `yuv420p`; áudio `aac` 192k.

`assembleJob()` normaliza cada faixa de narração (48 kHz estéreo,
`apad`/`atrim` à duração real do segmento) antes de concatenar, para a
timeline de áudio ficar amostra-a-amostra alinhada com o vídeo.

## B-roll (`broll.ts`)

Resolve o clip visual de cada segmento (Fase B, passo 3 do pipeline),
pela cascata do `ARCHITECTURE.md` §7 — **nunca deixa um segmento sem
visuais** e funciona **sem chaves nenhumas**:

```ts
import { resolveBrollForSegments } from '@shorts-forge/video';

// depois de retimeSpec(): preenche segment.broll em todos os segmentos
await resolveBrollForSegments(spec.segments, {
  format: spec.format,            // '9:16' → pesquisa portrait
  cacheDir: 'outputs/cache/broll',
  projectDir: 'projects/meu-video', // guarda broll-registry.json
});
```

1. **Pexels** (se `PEXELS_API_KEY` no `.env`) — pesquisa por
   `visualKeywords` (`orientation=portrait` para 9:16); escolhe a
   rendition mp4 mais próxima do alvo.
2. **Pixabay** (se `PIXABAY_API_KEY`) — mesma lógica.
3. **Ken Burns** (sem chaves / falha de API) — clip mp4 **real** gerado
   com FFmpeg: zoom lento sobre um still em gradiente (5 paletas,
   determinísticas por segmento). Enche exatamente o
   `actualDurationSec`.
4. **Fundo de template** (último recurso) — gradiente gerado com FFmpeg;
   se nem o FFmpeg existir, o `broll` fica com `url: ''` e o
   `buildFrames()` usa a cor do template — sempre válido.

Regras:

- **Pontuação** (`scoreCandidate`, determinística e documentada no
  código): 55% relevância (overlap keywords/descrição ↔ tags), 35%
  ajuste de duração (exato = 1,0; mais comprido decai até 0,7 — corta-se;
  mais curto até 0,75 — tem de fazer loop), 10% orientação.
  A duração do clip é registada **honestamente** — cortar ou fazer loop
  é decisão de montagem, não daqui.
- **No-repeat**: `UsedClipRegistry` (JSON em
  `<projectDir>/broll-registry.json`) — um clip nunca se repete no mesmo
  projeto, incluindo as variantes Ken Burns.
- **Cache**: `<cacheDir>/<clipId>.mp4` — nunca se volta a sacar; a chave
  inclui a origem + id do clip.
- **Degradação graciosa**: erros/timeouts/rate-limits das APIs atravessam
  a cascata em silêncio (log, sem crash).

Testes em `src/test/broll.test.ts`: pontuação, no-repeat, ordem da
cascata (HTTP simulado), cache hit/miss, mais 2 testes **ao vivo**
guardados por `PEXELS_API_KEY`/`PIXABAY_API_KEY` (saltam com motivo
claro quando não há chave — nunca simulados).

## Desenvolver

```bash
npm run build      # tsc
npm run typecheck  # tsc --noEmit
npm test           # tsc + node --test (83 testes, 81 verdes, 2 saltos honestos)
```

## Para a Fase 3/4 (estado: feito)

- **Render por segmento**: `buildSegmentFrame(segment, template)` →
  `buildSegmentComposition(…)` → `lintCompositionHtml` como gate →
  `renderSegmentClip(…)` (ou `renderJobSegments(spec, …)` para a Spec
  toda). Inclui hook line (`Segment.hookLine`, overlay na cor accent) e
  legendas karaoke dos `words[]` reais do TTS.
- **Preview**: `renderPreviewMp4(spec, outPath)` — render único a
  360x640, servido em `GET /api/jobs/:id/preview` (com cache por hash da
  Spec no pipeline).
- **Montagem**: `assembleJob({ segments, segmentClips, outDir, format })`
  — normaliza o áudio TTS por segmento e corre o FFmpeg com
  `buildAssembleArgs(…)`; o pipeline chama-o na Fase B e expõe o
  resultado em `GET /api/jobs/:id/download`.
- **B-roll em vídeo**: o adaptador emite `<video>` para URLs `.mp4`/
  `.webm`/`.mov`; `resolveBrollAssetUrl` prefere `localPath` (ficheiro
  local → `file://`) e aceita URLs http(s).
