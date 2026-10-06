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

## Fase 3 — Imagem + B-roll + i18n 🔶 em curso (QA: 2026-10-06)

**Objetivo:** ver o vídeo antes do render final; B-roll real com
fallbacks; narração em 4 idiomas.

**Estado verificado contra a realidade** (não contra planos):

- [x] `video`: `buildFrames()` após re-temporização (puro, testado) →
  `renderFrames()` por segmento (adaptador já verificado na Fase 1);
  `lintCompositionHtml` como gate
- [x] B-roll: cascata real `Pexels → Pixabay → Ken Burns local →
  fundo gerado` (`packages/video/src/broll.ts`) — **23/23 testes verdes**
  com HTTP mockado (ordem da cascata, never-empty, cache por `clipId`,
  registo no-repeat por projeto em `broll-registry.json`,
  `orientation=portrait` para 9:16); testes LIVE honestos saltam sem chaves
- [x] i18n: `packages/tts/voices.catalog.json` (fonte única de verdade) +
  `pipeline/src/voiceCatalog.ts` + `ui/src/lib/voices.ts` + **seletor de
  idioma na UI** (`StepInput`) e voice picker (`StepVoice`); 4 idiomas:
  pt-PT (edge-tts `pt-PT-DuarteNeural`), pt-BR (kokoro `pf_dora`),
  en (kokoro `af_heart`), fr (kokoro `ff_siwis`) — 17 testes de contrato
  verdes; orçamentos de legendas por idioma (`getCaptionBudget`,
  `wrapCaptionLines` — 8 testes verdes)
- [x] `pipeline`: `GET /api/jobs/:id/download` serve o MP4 real (200 com
  bytes + `Content-Disposition`; 404/409 honestos); `POST /api/jobs`
  aceita os 4 idiomas e o `{ tts: { engine, voice } }` da UI
- [x] `preview()`: `GET /api/jobs/:id/preview` **real** (render leve Hyperframes 360x640 com cache por hash da Spec; 409 `preview_not_ready` sem Spec, 404 job desconhecido) — verificado ao vivo: 200 `video/mp4` em ~14 s, 2ª chamada em 0,005 s (cache). O contrato de teste 501 foi substituído pelo comportamento real, como a nota do próprio teste previa.
- [x] `video.assemble()`: **real** (`assembleJob()` — FFmpeg com `buildAssembleArgs()`, normalização de áudio 48 kHz estéreo amostra-a-amostra, `detectHwAccel()` honestificado com probe de encode real); e2e honesto: 2 segmentos → `final.mp4` verificado com ffprobe (h264 1080x1920 + aac).
- [x] B-roll ligado na orquestração: `resolveBrollForSegments()` corre na Fase B após `retimeSpec()` (cache em `outputs/cache/broll`, registo no-repeat em `outputs/<jobId>/broll-registry.json`).
- [x] Testes pytest da transcrição ligados ao `npm test` (skip gracioso sem venv).
- [x] **Regressão de typecheck resolvida no próprio dia**: `npm run
  typecheck` do `pipeline` falhou temporariamente (`src/orchestrate.ts:307`,
  `src/server.ts:219` — `exactOptionalPropertyTypes` vs assinatura de
  `resolveTtsForJob`); reportada ao dono (engenharia (c)), que aplicou o
  fix de uma linha no `voiceCatalog.ts` e adicionou os próprios testes
  (`test/voiceCatalog.test.ts`). `npm run typecheck` verde em todos os
  workspaces.
- [ ] Validação ao vivo: pesquisas Pexels/Pixabay reais (testes LIVE
  saltam sem chaves); nomes de vozes `verified: false` por confirmar no
  PC da Joana (fr-FR-DeniseNeural/HenriNeural, pt-BR-FranciscaNeural,
  en-US-AriaNeural, …) + amostras de escuta em francês (ver
  `TEST_PLAN.md` §15.4)

**Done (quando fechar):** preview real de baixa resolução por segmento;
typecheck verde; validação ao vivo das chaves B-roll e das vozes por
confirmar.

> Nota de âmbito: o bullet "Multi-idioma de narração além de pt-PT" saiu
> de "Fora de âmbito" — a Fase 3 entrega pt-PT, pt-BR, inglês e francês
> (decisão da Joana, 2026-10-06; o ROADMAP antigo ficou para trás).

## Fase 4 — Montagem + QC (assemble real + quality-review)

**Objetivo:** MP4 final com B-roll real, verificado automaticamente.

**O que a Fase 3 já entregou** (não repetir): resolução de B-roll por
segmento com cascata Pexels → Pixabay → Ken Burns → template, cache por
`clipId` em `outputs/cache/broll/`, registo no-repeat por projeto,
`orientation=portrait` para 9:16 e scoring por relevância/duração/
orientação. O que falta aqui é **afinação**, não construção.

- **Afinação semântica do B-roll**: melhorar o scoring com os dados reais
  das pesquisas (a heurística atual usa overlap de keywords/tags; validar
  com pesquisas reais e ajustar pesos); `buildAssembleArgs()` já testado
- `video.assemble()` **real**: `renderFrames()` por segmento →
  concatenação com as faixas de narração TTS (spawn do FFmpeg com
  `buildAssembleArgs()`); o stub atual lança honestamente
- `GET /api/jobs/:id/preview` real (baixa resolução) ligado à UI
- **QC automático pós-render** (ideia adotada do OpenMontage): etapa `qc`
  entre render e `done` — duração vs soma de `actualDurationSec`, streams,
  resolução, frames pretos (`blackdetect`), silêncio (`silencedetect`),
  clipping (`astats`), legendas presentes, integridade (`ffprobe`);
  estado `qc-failed` bloqueia o download até correção/aprovação manual
- **Presets por plataforma** (TikTok/YouTube/Instagram) no `RenderOptions`
- Validação ao vivo das pesquisas Pexels/Pixabay com chaves gratuitas
  (os testes LIVE da Fase 3 saltam sem chaves)

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
- Edição avançada na UI (corte fino, keyframes) — só o essencial
- Copiar código de outros projetos — ideias e conceitos sim, código não
  (licença AGPL-3.0; reutilização MIT/Apache só com origem documentada
  e compatibilidade verificada)
