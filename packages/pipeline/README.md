# @shorts-forge/pipeline

Orquestrador do pipeline shorts-forge: **Fase A** (o LLM escreve o plano — a `Spec`) e **Fase B** (o TTS gera o áudio real e cada plano é re-temporizado com os timestamps medidos). Expõe a **API REST** do contrato congelado (`ARCHITECTURE.md` §8) em `http://localhost:3000/api`, com progresso via SSE.

> Estado (Fase 2): `spec`, `retime`, `cache`, `pythonBridge`, `jobs`,
> `services`, `ttsConfig`, `llmStatus`, `orchestrate` (orquestrador real) e
> `server` (API REST + SSE) são **reais e testados**. A **montagem de vídeo**
> (pacote `video`, Fase 4) continua a ser um stub honesto: o render completa
> TTS + re-temporização e marca o job como `done`, mas o `/download` responde
> 409 até à Fase 4 — nenhum MP4 é fingido.

## Arrancar a API

```bash
npm run dev:pipeline   # na raiz do repo — compila e serve http://localhost:3000/api
# ou, dentro de packages/pipeline:
npm run dev            # = build + serve
npm run serve          # só serve (precisa de build prévio)
```

A porta vem de `PIPELINE_API_PORT` (omissão **3000** — o contrato congelado;
ver `.env.example`). O `packages/ui/src/lib/api.ts` já aponta para
`http://localhost:3000/api`, por isso nenhuma mudança na UI é precisa.

## API REST (contrato congelado, ARCHITECTURE.md §8)

| Método | Rota | Resposta |
|---|---|---|
| `POST` | `/api/jobs` `{input, format, language}` | `201 { job }` |
| `POST` | `/api/jobs/:id/spec` | `200 { spec }` — Fase A (emite SSE `spec-draft` → `awaiting-approval`) |
| `PUT` | `/api/jobs/:id/spec` `{spec}` | `200 { job }` — valida (estrita) e guarda; `400` se inválida |
| `POST` | `/api/jobs/:id/render` | `202 { job }` — Fase B assíncrona (`rendering` → `done`/`failed`) |
| `GET` | `/api/jobs/:id` | `200 { job }` |
| `GET` | `/api/jobs/:id/events` | SSE: `spec-draft`, `awaiting-approval`, `rendering`, `done`, `failed`, `progress` |
| `GET` | `/api/jobs/:id/download` | MP4 (quando existir); `409` honesto até à Fase 4 |
| `GET` | `/api/jobs/:id/preview` | `501` honesto (pré-visualização chega na Fase 4) |
| `GET` | `/api/llm/status` | `200 { providers: ProviderStatus[] }` |
| `POST` | `/api/llm/chat` | passthrough de debug → `ChatResult` |

Erros: `{ error: { code, message } }`, `message` sempre em pt-PT (a UI
mostra-o tal qual).

## Módulos

### `src/spec.ts` — Fase A: gerar a Spec via LLM

`generateSpec(input, router, opts?) → Promise<Spec>`

- Recebe o router de LLMs **injetado** (qualquer objeto com `chatJson(req)`), por isso é testável sem rede.
- Constrói um system prompt (engenharia de prompt em inglês) que exige **JSON estrito** com: `title`, `segments[]` (`id`, `narration`, `visualKeywords`, `brollDescription`, `targetDurationSec`, `hookScore`, `hookLine`).
- Para `kind: 'audio'` com `opts.transcript`, o prompt inclui a transcrição **com os tempos reais de cada palavra** e instrui o modelo a alinhar cada `targetDurationSec` com esses tempos (derivar, não inventar).
- `validateSpecJson(raw, opts?)` valida de forma estrita e lança `Error` em pt-PT a nomear o campo ofensor: `segments` não vazio, `id` únicos, `narration` não vazia, `targetDurationSec > 0`, `visualKeywords` com 1–4 itens, `brollDescription` não vazia, `hookScore` 0–1. Se `opts.targetDurationSec` for dado, a soma das durações tem de estar a ±20% do alvo (regra do ARCHITECTURE.md).
- Aceita ainda que o modelo devolva uma string JSON (mesmo dentro de ```json fences).

**Decisão — palavras-chave em inglês:** a narração é pedida em **português europeu** (pt-PT: "telemóvel", "ecrã", "tu", "estou a fazer"), mas as `visualKeywords` são pedidas em **INGLÊS**. Motivo: as APIs de stock footage (Pexels, Pixabay) indexam muito melhor em inglês; palavras-chave portuguesas devolvem poucos ou maus resultados. A `brollDescription` pode ficar em pt-PT (é só para humanos/LLM).

### `src/retime.ts` — Fase B: re-temporização (o coração da arquitetura)

`retimeSpec(spec, ttsBySegment, opts?) → Spec` — **pura, sem I/O, não muta a entrada.**

Regra "medir, não estimar": para cada segmento com resultado de TTS,

```
actualDurationSec = (fim da última palavra falada) + breathMarginSec
```

- `breathMarginSec` por omissão `0.25` — uma pequena "respiração" para os cortes não parecerem abruptos.
- O resultado de TTS (`audioPath`, `words`, `durationSec`) é anexado ao segmento.
- **Segmento sem TTS:** mantém `targetDurationSec`, fica sem `actualDurationSec` — nunca se inventa temporização.
- **TTS sem palavras:** o áudio é anexado, mas não há `actualDurationSec` (não há fim de palavra para medir).
- `totalDurationSec(spec)` soma `actualDurationSec` onde existir, `targetDurationSec` nos restantes.

Isto elimina o drift guião↔áudio e dá as legendas karaoke "de graça" (os `words[]` já existem).

### `src/cache.ts` — cache de transcrições

`getCachedTranscript(audioPath, cacheDir?)` / `putCachedTranscript(audioPath, result, cacheDir?)`

- Chave = **sha256 dos bytes do ficheiro de áudio** — o mesmo áudio nunca é transcrito duas vezes.
- Diretório por omissão: `<repo>/outputs/.cache/transcripts` (a raiz do repo é localizada a partir do módulo).
- Ficheiros de cache corruptos, com hash errado ou forma inválida → tratados como *miss* e substituídos na próxima escrita.

### `src/pythonBridge.ts` — cliente HTTP para a Fase 2

`class ServiceClients` — cliente **real** (fetch) para os serviços Python **que ainda não existem**:

| Método | Pedido | Resposta |
|---|---|---|
| `transcribe(audioPath)` | `POST /transcribe` `{ audioPath }` | `TranscriptionResult` |
| `synthesize(text, voice, rate)` | `POST /synthesize` `{ text, voice, rate }` | `TtsResult` |
| `health()` | `GET /health` (ambos) | `{ transcription: boolean, tts: boolean }` |

- URLs base por omissão: transcrição `http://127.0.0.1:8001`, TTS `http://127.0.0.1:8002` (configuráveis no construtor).
- Falha de ligação → `Error` claro em pt-PT ("serviço de transcrição indisponível — Fase 2 …"). `health()` nunca lança — reporta alcançabilidade.
- **Nota de contrato:** o ARCHITECTURE.md §4.4 propõe `{ text, voice, language }` no `/synthesize`; este cliente envia `{ text, voice, rate }` (o contrato definido para o pipeline). A Fase 2 deve alinhar o servidor Python com este contrato.

### `src/orchestrate.ts` — orquestrador real (Fase 2)

`PipelineOrchestrator` implementa a interface `Pipeline` do `ARCHITECTURE.md`
§4.3: `createJob` → `generateSpec` (Fase A) → `approveSpec` → `render`
(Fase B) → `getJob`, mais `specEvents()` (`AsyncIterable<JobEvent>` para o
SSE). O `runPipeline` que lançava sempre foi removido — a orquestração é
real.

- **Fase A:** áudio → `ServiceClients.transcribe` (com cache por sha256 em
  `cache.ts`) → `generateSpec` (llm-router injetado) → `validateSpecJson`
  (estrita) → job em `awaiting-approval`. Tema → direto ao LLM. Falha de LLM
  → job `failed` com a mensagem agregada do router (acionável, pt-PT).
- **Fase B:** por segmento, `services.synthesize(narration, voice, rate,
  provider)` (provider de `TTS_ENGINE`, omissão `kokoro`) → `retimeSpec()`
  com os timestamps REAIS → `actualDurationSec` medido. Depois, a **montagem
  de vídeo é um stub explícito da Fase 4**: o `assemble()` do pacote `video`
  ainda lança, por isso o passo só verifica o FFmpeg real (`detectHwAccel()`)
  e marca a fronteira nos eventos; o job termina `done` com a Spec
  re-temporizada e o áudio TTS prontos, mas **sem** `outputPath` — o
  `/download` responde 409 honesto. Nenhum MP4 é fingido.
- **Simplificação conhecida:** em entradas por áudio, a Fase B volta a
  sintetizar a narração com TTS em vez de reutilizar a gravação original
  (a transcrição conduz a Fase A, com tempos). Reutilizar a voz gravada é
  trabalho futuro (Fase 3+).

### `src/jobs.ts` — modelo Job, store em memória e bus de eventos

`Job { id, status, input, format, language, spec?, progress, error?,
outputPath?, createdAt, updatedAt }`, `JobStore` (criar/ler/atualizar/falhar)
e `emit()` para o bus de eventos por job (SSE + `AsyncIterable`). `ApiError
{ code, httpStatus, message }` — as rotas traduzem-no para a forma congelada
`{ error: { code, message } }`.

### `src/services.ts` — ciclo de vida dos serviços Python

`ServiceManager`: arranque **preguiçoso** (só no primeiro `ensure*`),
probe `GET /health`, spawn do processo Python quando há comando conhecido
(`TRANSCRIPTION_SERVICE_CMD` / `TTS_SERVICE_CMD`, ou
`packages/<transcription|tts>/service.py --port <porta>` se existir),
espera limitada pelo `/health` (nunca pende em silêncio), paragem após
`idleTimeoutMs` sem uso e `shutdown()` no encerramento do servidor
(SIGINT/SIGTERM). Sem comando e sem serviço → erro pt-PT acionável
("…ou corre `npm run models:download`").

### `src/ttsConfig.ts`, `src/llmStatus.ts`

`resolveTtsConfig()` lê `TTS_ENGINE` (kokoro/edge-tts/google; omissão kokoro),
a voz (`KOKORO_VOICE`/`EDGE_TTS_VOICE`/`GOOGLE_TTS_VOICE`; vazia = voz por
omissão do serviço) e `SPEECH_RATE`. `getProviderStatuses()` constrói o
`GET /api/llm/status` a partir do `loadConfigFromEnv()` do llm-router +
probes de alcançabilidade (nunca lança; providers sem chave aparecem com
`quotaHint`).

### `src/server.ts` — API REST + SSE (só `node:http`, sem frameworks)

`createServer(deps)` (injetáveis — os testes usam um `Pipeline` fake) e
`startServer()` (dependências reais: router via `loadConfigFromEnv()`,
`ServiceClients`, `ServiceManager`, `PipelineOrchestrator`). Execução direta:
`node dist/src/server.js`. CORS permissivo para dev local (a UI em :5173).

## Testes

```bash
npm test   # tsc → node --test dist/test
```

- `test/retime.test.ts` — caso normal com palavras sintéticas, caso de palavras vazias, multi-segmento, verificação de não-mutação, margem personalizada, arredondamento a ms.
- `test/cache.test.ts` — round-trip em diretório temporário, estabilidade do hash (ficheiros diferentes, mesmos bytes), ficheiro corrupto → miss + sobrescrita, hash errado → miss, forma inválida → miss.
- `test/spec.test.ts` — router MOCK (sem rede): Spec válida passa, prompt contém instruções pt-PT/keywords inglesas, transcrição incluída no prompt de áudio; validação rejeita narração em falta, ids duplicados, duração inválida, keywords a mais/menos, segmentos vazios, hookScore fora de 0–1.
- `test/orchestrate.test.ts` — ciclo de vida com router e `ServiceClients` MOCK (sem rede): topic → spec → approve → render → `done`, com `segments[].tts` de durações reais e `actualDurationSec` re-temporizado; falha do LLM → job `failed` com mensagem acionável; `PUT` inválida → 400 sem falhar o job; áudio → transcrição com cache (2.º job igual não volta a transcrever); `specEvents` emite `spec-draft` → `awaiting-approval`.
- `test/server.test.ts` — contrato REST com `Pipeline` fake: 201/200/202/404/409/501, forma de erro `{ error: { code, message } }`, SSE (3 frames: snapshot + `progress` + `done`), `/download` honesto, `/preview` 501, `/llm/status` e `/llm/chat`.
- `test/services.test.ts` — `ServiceManager`: serviço em baixo sem comando de spawn → erro pt-PT acionável (sem hangs); spawn falhado → erro limitado no tempo; `shutdown()` idempotente; `resolveTtsConfig` (omissões, `edge`→`edge-tts`, `google`, configs inválidas → 500 pt-PT).
- `test/orchestration.contract.test.ts` — testes de contrato **vivos** contra `http://localhost:3000/api` (saltam com motivo se o servidor não estiver a correr; o ciclo completo tema→Spec→render salta se nenhum LLM estiver alcançável).

## Dependências

- `@shorts-forge/shared` — tipos canónicos (`Spec`, `Segment`, `Word`, `PipelineInput`, `TranscriptionResult`, `TtsResult`, `ChatRequest`, …).
- `@shorts-forge/llm-router` — `createRouter`/`loadConfigFromEnv` para a Fase A e o `/api/llm/*`.
- `@shorts-forge/video` — `detectHwAccel()` (sonda real de FFmpeg no passo da Fase 4).
- dev: `typescript`, `@types/node`.

## Limitações conhecidas (Fase 2)

- **Jobs em memória:** o `JobStore` não sobrevive a um restart do servidor. A biblioteca de projetos durável é Fase 6.
- **Montagem de vídeo:** stub explícito da Fase 4 (ver `src/orchestrate.ts`). O `GET /download` responde 409 honesto até lá.
- **Voz por omissão:** se `KOKORO_VOICE`/`EDGE_TTS_VOICE`/`GOOGLE_TTS_VOICE` estiver vazia, usa-se a voz por omissão do serviço Python (a escolha da voz pt-PT do Kokoro é o risco n.º 1 — as amostras de voz são o ponto de aprovação da Joana na Fase 2).
