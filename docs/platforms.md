# Presets de plataforma

O shorts-forge renderiza para **plataformas**, não só para proporções. Cada
preset junta a resolução, a duração máxima recomendada, as **margens de
área segura das legendas**, o alvo de loudness e as particularidades da
plataforma. A UI oferece um seletor de preset; o render honra-o de ponta a
ponta (resolução, posicionamento das legendas, loudness final).

> **Valores sensatos, não especificações oficiais.** Os números abaixo são
> valores documentados e conservadores, derivados dos factos estáveis de
> layout de cada app (vídeo vertical tem um rail de ações à direita e uma
> zona de progresso/título em baixo; vídeo horizontal tem a barra do leitor
> em baixo), com margens de segurança. Se uma plataforma redesenhar o
> leitor, atualizam-se as áreas seguras em
> `packages/video/src/presets.ts` — tudo o resto (CSS das legendas,
> preview, este doc) segue automaticamente.

## Os quatro presets

| Preset | Rótulo (UI) | Resolução | Proporção | Duração máx. recomendada | Loudness |
|---|---|---|---|---|---|
| `tiktok` | TikTok | 1080×1920 | 9:16 | 3 min | −14 LUFS |
| `youtube-shorts` | YouTube Shorts | 1080×1920 | 9:16 | 3 min | −14 LUFS |
| `youtube-long` | YouTube (vídeo longo) | 1920×1080 | 16:9 | sem limite prático | −14 LUFS |
| `instagram-reels` | Instagram Reels | 1080×1920 | 9:16 | 3 min | −14 LUFS |

### Áreas seguras (margens das legendas, em fração do canvas)

| Preset | Topo | Direita | Fundo | Esquerda | Porquê |
|---|---|---|---|---|---|
| `tiktok` | 10% | 15% | 16% | 6% | Rail de ações à direita; barra de progresso + descrição em baixo; estado/pesquisa em cima. |
| `youtube-shorts` | 8% | 8% | 14% | 6% | Título e canal sobrepostos em baixo; rail mais estreito que no TikTok. |
| `youtube-long` | 8% | 4% | 12% | 4% | Barra do leitor em baixo; sem rails laterais — margens pequenas. |
| `instagram-reels` | 10% | 12% | 18% | 6% | Zona de descrição larga em baixo (a maior dos verticais); rail de ações à direita. |

**Como se aplicam:** o CSS da composição Hyperframes (`captionCss`) usa
`captionBoxFor()` (`packages/video/src/captions.ts`):

- legendas `lower-third`: o afastamento do fundo é o **máximo** entre o
  omisso do template (14%) e a margem de fundo do preset — ex.: no TikTok
  as legendas sobem para 16%;
- legendas `center`: mantêm-se centradas, mas a largura máxima encolhe
  para `100% − esquerda − direita`, para o texto nunca passar por baixo
  dos rails laterais;
- a linha de hook (`top`) respeita o **máximo** entre o omisso do template
  (7%) e a margem de topo do preset.

Os templates (`packages/video/src/templates.ts`) declaram apenas a
*preferência* de posição (`center` / `lower-third`); as margens concretas
vêm sempre do preset. Ou seja: mudar de preset muda onde as legendas
ficam, sem tocar nos templates.

**Loudness:** todos os presets miram **−14 LUFS integrados** (o alvo para
o qual o YouTube normaliza; TikTok e Instagram comportam-se de forma
semelhante). A montagem final (`buildAssembleArgs`, FFmpeg `loudnorm`)
aplica esse alvo quando o render corre com preset; sem preset, mantém-se o
comportamento anterior (−16 LUFS).

**Durações:** 3 minutos é o teto para contar como Short/Reel/TikTok curto
— acima disso, o vídeo deixa de ser distribuído como formato curto. Para
YouTube longo não há teto prático nesta ferramenta (`null` no preset).

## Fluxo: UI → API → render

```
UI (StepFormat) → POST /api/jobs { input, preset, format?, language, tts? }
                  → Job { preset, format, … }
                  → Fase B: renderJobVideo(preset) → clips + assemble (loudnorm)
                  → GET /api/jobs/:id/preview (baixa resolução, mesma proporção + áreas seguras)
```

### Precedência `preset` vs `format`

O campo `preset` é **opcional** em `POST /api/jobs` (o `format` continua a
funcionar como antes):

1. **`preset` explícito e válido ganha** — e impõe o seu próprio formato,
   mesmo que `format` venha com valor conflituante. Ex.: `preset:
   "tiktok"` + `format: "16:9"` → o job fica `preset: "tiktok"`,
   `format: "9:16"`.
2. **Só `format`** → resolve para o preset omisso dessa proporção: `9:16`
   → `youtube-shorts`, `16:9` → `youtube-long`. Comportamento legado
   preservado (as margens omissas destes dois presets coincidem com o
   posicionamento anterior das legendas).
3. **Nem um nem outro** → `format` omite para `9:16` e o preset resolve
   para `youtube-shorts`.
4. **`preset` desconhecido** → `400 invalid_input` com a lista de presets
   válidos (mensagem em pt-PT).

O job guarda sempre o preset resolvido (`Job.preset`), por isso a Fase B —
incluindo o preview de baixa resolução — usa as mesmas áreas seguras e o
mesmo alvo de loudness do render final.

## Ficheiros

- `packages/shared/src/index.ts` — `PlatformPresetId`, `SafeArea` (tipos canónicos).
- `packages/video/src/presets.ts` — catálogo + `getPreset`, `resolvePreset`,
  `defaultPresetForFormat`, `safeAreaPx`, `isPlatformPresetId`.
- `packages/video/src/captions.ts` — `captionBoxFor()`, `hookTopFrac()`.
- `packages/video/src/hyperframesAdapter.ts` — `CompositionOptions.safeArea`.
- `packages/video/src/render.ts` — `canvasForPreset()`, `renderTargetFor()`,
  `preset` em `SegmentRenderOptions` / `PreviewRenderOptions` /
  `JobVideoOptions` / `VideoRenderer`.
- `packages/video/src/ffmpeg.ts` — `loudnessLufs` em `AssembleOptions` /
  `AssembleJobInput` (omissão −16 sem preset).
- `packages/pipeline/src/jobs.ts` — `Job.preset`.
- `packages/pipeline/src/orchestrate.ts` — resolução do preset em
  `createJob` (precedência), `preset` no `RenderVideoFn`.
- `packages/pipeline/src/server.ts` — campo `preset` em `POST /api/jobs`;
  preview com `job.preset`.
- `packages/ui/src/lib/presets.ts` — rótulos/descrições pt-PT para o seletor.
