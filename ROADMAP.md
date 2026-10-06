# Roadmap — shorts-forge

> Versão do coordenador (final). Fases sequenciais; cada fase termina com
> um marco verificável ("definition of done").

## Fase 1 — Fundações ✅ concluída

**Objetivo:** o esqueleto do monorepo existe, compila e os contratos estão
congelados.

- [x] Scaffold: `package.json` (workspaces), `.gitignore`, `README.md`,
      `LICENSE` (AGPL-3.0, texto completo)
- [x] `packages/shared`: tipos canónicos + compilação TypeScript verificada
- [x] `ARCHITECTURE.md` (contratos UI↔backend, desenho do pipeline em duas
      fases, política free-only)
- [x] `packages/llm-router`: `chat()`/`chatJson()` funcionais, cadeia de 8
      providers com failover automático — **9/9 testes verdes**, 100% offline
- [x] `packages/pipeline`: geração de Spec com validação estrita,
      `retimeSpec()` pura (coração da Fase B), cache de transcrições,
      cliente HTTP dos serviços Python — **32/32 testes verdes**
- [x] `packages/video`: 3 templates, legendas karaoke com tempos reais,
      **adaptador Hyperframes REAL e verificado end-to-end** (MP4 1080x1920
      renderizado de verdade, karaoke confirmado em frames extraídos),
      construtor de comandos FFmpeg (ducking + loudnorm + deteção de GPU) —
      **32/32 testes verdes**
- [x] `packages/ui`: wizard de 4 passos + 3 gates de revisão sobre dados de
      exemplo, **adaptador WebLLM real** (modo browser, sem chave),
      cliente API tipado — `npm run build` e dev server verificados
- [x] `packages/transcription` + `packages/tts`: stubs de contrato HTTP
      (implementação Python na Fase 2)
- [x] `scripts/doctor.mjs` (exit 0), `.env.example` completo, `TEST_PLAN.md`
- [x] `docs/tts-providers.md` (Google Cloud TTS como provider first-class;
      decisão SSML marks + fallback whisper) e
      `docs/openmontage-evaluation.md` (ideias adotadas/adaptadas)

**Done:** `npm run typecheck` e `npm test` passam em todos os workspaces;
router com failover demonstrável; karaoke com tempos 100% reais.

## Fase 2 — Voz e guião (transcription + TTS + Spec) 🔶 em curso

**Objetivo:** do áudio/tema até à Spec aprovada, com áudio real por
segmento.

**Estado verificado em 2026-10-06** (QA: testado contra o que corre, não
contra planos):

- [x] Serviço Python `transcription` (faster-whisper): `POST /transcribe`
      → `TranscriptionResult` com `word_timestamps=True`; **verificado ao
      vivo** com 30 s de fala pt (53 palavras, `language: 'pt'`,
      timestamps sãos); `GET /health` → `{ ok: true, modelsLoaded }`
- [x] Script `models:download` real e idempotente (whisper + Kokoro via
      Hugging Face; `--only=`); `npm run doctor` e `npm run
      models:download` ligados no `package.json` raiz
- [x] `pipeline`: API REST em `:3000` a implementar o contrato congelado
      §8 (`POST /api/jobs` → 201, `POST …/spec`, `PUT …/spec`,
      `POST …/render` → 202, SSE de eventos, `GET /api/llm/status`);
      `orchestrate.ts` real (Fase A → aprovação → Fase B);
      `ServiceManager` (spawn/arranque preguiçoso dos serviços Python);
      **6/7 testes de contrato verdes ao vivo**
- [x] Testes de contrato dos serviços Python (fakes + ao vivo) e matriz de
      validação dos SSML marks (17 testes pytest verdes)
- [ ] Serviço Python `tts`: servidor + 3 providers + fallback
      faster-whisper **implementados** (`app.py`, `providers/`,
      `whisper_retime.py`), mas **ainda não correu com modelos reais**
      (venv sem dependências; Kokoro/Edge-TTS/Google por instalar) —
      `POST /synthesize` por validar ao vivo
- [ ] Validar naturalidade da voz pt-PT do Kokoro — **risco principal**;
      amostras de escuta para a Joana ainda por gerar (ver
      `TEST_PLAN.md` §11)
- [ ] Ciclo completo tema→Spec→TTS→durações reais (requer LLM + TTS
      ligados; a Fase A foi validada até ao ponto do LLM)
- [ ] `GET /health` do TTS ao vivo; nomes exatos das vozes pt-PT
      por confirmar; preços do tier grátis Google por confirmar

**Done (quando fechar):** job tema→Spec→TTS produz `segments[].tts` com
durações reais; transcrição de áudio de 60 s com word timestamps corretos;
3 providers TTS comutáveis.

## Fase 3 — Imagem (Hyperframes + legendas + preview)

**Objetivo:** ver o vídeo antes do render final.

- `video`: `buildFrames()` após re-temporização → `renderFrames()` por
  segmento (adaptador já verificado); `lintCompositionHtml` como gate
- `preview()`: HTML autónomo já existe → ligar ao passo de preview da UI
- B-roll em vídeo (URLs mp4/webm como `<video>`) — validar além do
  fallback de imagem/cor
- `pipeline`: SSE de progresso dos jobs

**Done:** preview de 3 segmentos com legendas karaoke sincronizadas,
gerado só com dados medidos; `hyperframes lint` sem erros.

## Fase 4 — Montagem + QC (B-roll + FFmpeg + quality-review)

**Objetivo:** MP4 final com B-roll real, verificado automaticamente.

- Resolução de B-roll por segmento: matching semântico com as keywords
  do LLM (Pexels → Pixabay → imagem local com Ken Burns); registo
  no-repeat por projeto; `orientation=portrait` para 9:16
- `video.assemble()`: spawn do FFmpeg com `buildAssembleArgs()` (já
  testado); cache de B-roll em `outputs/cache/broll/`
- **QC automático pós-render** (ideia adotada do OpenMontage): etapa `qc`
  entre render e `done` — duração vs soma de `actualDurationSec`, streams,
  resolução, frames pretos (`blackdetect`), silêncio (`silencedetect`),
  clipping (`astats`), legendas presentes, integridade (`ffprobe`);
  estado `qc-failed` bloqueia o download até correção/aprovação manual
- **Presets por plataforma** (TikTok/YouTube/Instagram) no `RenderOptions`
- `pipeline`: `POST /api/jobs/:id/render` + `GET /api/jobs/:id/download`

**Done:** MP4 9:16 de 30–60 s com B-roll, legendas e áudio, gerado
end-to-end sem intervenção após aprovação da Spec, com relatório QC
verde.

## Fase 5 — Produto (UI ligada + packaging)

**Objetivo:** a Joana usa com poucos cliques, num PC limpo.

- `ui` ligada ao backend: `createJob()` + `generateSpec()` no lugar dos
  dados de exemplo; gates ligados a `approveSpec()`; progresso real via
  SSE; download via `getDownloadUrl()` (a `api.ts` já aponta para
  `http://localhost:3000/api` — zero mudanças de contrato)
- Seletor de modo LLM com os 3 modos (cadeia cloud / sem chave /
  browser WebLLM) + estado dos providers (`GET /api/llm/status`)
- Empacotamento: documento "do zero ao primeiro vídeo"
- Teste de aceitação: PC limpo → `doctor` → download de modelos →
  tema → vídeo final, só com cliques

**Done:** a Joana produz um short 9:16 a partir de um tema em < 15
minutos de interação.

## Fase 6 — Produto II (biblioteca de projetos)

**Objetivo:** os projetos passam a ser reutilizáveis.

- **Library de projetos** (ideia adotada do OpenMontage):
  `projects/<slug>/` (`project.yaml`, `spec.json`, `segments/`,
  `renders/`, `qc-report.json`, `thumb.jpg`) + índice local (JSON;
  SQLite só se preciso) + ecrã "Os meus vídeos" na UI, com reutilização
  de TTS/B-roll ao duplicar
- **`project.yaml`** (ideia adaptada): manifesto declarativo por projeto
  — registo/auditoria (Spec aprovada, assets, settings, QC), gerado ao
  concluir o job

**Done:** duplicar um projeto reaproveita TTS e B-roll sem regenerar.

## Fase 7+ — Ideias em avaliação

- B-roll por embeddings CLIP local (sobre o cache; modelo pequeno via
  `doctor`; desligável)
- "Modo inspiração": extrair só ritmo e ganchos de uma transcrição de
  referência para o prompt da Fase A (sem visão computacional)

## Fora de âmbito (por agora)

- Publicação automática (TikTok/YouTube/Instagram) — só download do MP4
- Vozes pagas (ElevenLabs) como requisito — proibido pela política
  free-only
- Multi-idioma de narração além de pt-PT — estrutura pronta (`language`),
  vozes depois
- Edição avançada na UI (corte fino, keyframes) — só o essencial
- Copiar código de outros projetos — ideias e conceitos sim, código não
  (licença AGPL-3.0; reutilização MIT/Apache só com origem documentada
  e compatibilidade verificada)
