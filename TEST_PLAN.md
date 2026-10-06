# Plano de Testes — shorts-forge (QA)

> Âmbito: **Fases 1–3** (fundações, voz e guião, imagem + B-roll + i18n).
> Cobertura dos contratos documentados em `ARCHITECTURE.md`; os pacotes
> `pipeline`, `video` e `ui` evoluíram em paralelo, por isso as estratégias
> visam as **interfaces documentadas e o código real** — o que ainda não
> corre é testado com skip explícito, nunca com "sucesso" fingido.
> Convenções: docs em pt-PT, identificadores de código em inglês.

## 1. Estratégia geral

- **Tipos canónicos** (`packages/shared`): compilação TypeScript + testes
  de "forma" — cada tipo exportado instancia-se com dados de exemplo
  válidos (Spec completa do `ARCHITECTURE.md` §5).
- **Lógica pura primeiro**: re-temporização, validação da Spec, cálculo de
  legendas e construção de args FFmpeg são funções puras → testes
  unitários determinísticos, sem mocks.
- **Fronteiras externas** (providers LLM, Pexels/Pixabay, processos
  Python): testes com *doubles* (stubs de HTTP, servidores fake locais);
  chamadas reais só em QA manual, nunca na suite automática.
- **Zero segredos nos testes**: chaves via `.env` de teste ou variáveis de
  ambiente falsas (`test-key-*`); o `doctor.mjs` nunca imprime valores.

## 2. llm-router — estratégia

Interface: `chat(req): Promise<ChatResult>`, `status(): ProviderStatus[]`,
`createRouter(config)`. Alvo: cadeia de 8 providers com failover
(`ARCHITECTURE.md` §6).

### 2.1 Matriz de failover (com servidor fake OpenAI-compatible)

Servidor fake local que responde por rota de provider, para injetar falhas
determinísticas:

| Caso | Estímulo | Esperado |
|---|---|---|
| 429 → próximo | 1.º provider devolve 429 | `ChatResult.provider` = 2.º provider; texto do 2.º |
| 429 com arrefecimento | 429, retry imediato | provider marcado em cooldown (ver `status().quotaHint`); retomado após expirar |
| Todos falham | todos 429/5xx/timeout | erro agregado que lista provider + motivo de cada tentativa |
| Keyless skip | sem `GEMINI_API_KEY` etc. | providers com chave são saltados em silêncio; cadeia efetiva = pollinations → ollama |
| Reordenação por env | `LLM_PROVIDERS=groq,gemini` | ordem de tentativa respeita o env; nomes desconhecidos ignorados com aviso |
| `jsonMode` | `jsonMode: true` | request inclui modo JSON quando o provider suporta; `text` parseável como JSON |
| Timeout | provider nunca responde | `timeoutMs` dispara → passa ao próximo; sem hang |

### 2.2 O que verificar no resultado

- `ChatResult { text, provider, model }` — `provider` e `model` refletem
  **quem respondeu de facto**, não o primeiro da lista.
- `status()` devolve um `ProviderStatus` por provider com
  `reachable`/`keyless` corretos; nunca lança.

### 2.3 Sem rede

- Com `LLM_PROVIDERS` vazio/inválido → erro claro em pt-PT (mensagem da
  UI), não crash.
- Suite `npm test` do pacote deve passar offline (fakes locais), como já
  faz hoje (`tsc` + `node --test`).

## 3. pipeline — estratégia

Interface: `createJob`, `generateSpec` (Fase A), `approveSpec`,
`render` (Fase B), `getJob`, `specEvents` (SSE). REST em
`ARCHITECTURE.md` §8.

### 3.1 Re-temporização (função pura — casos)

Entrada: segmento com `tts.durationSec` e `words[]`.

| Caso | Entrada | Esperado |
|---|---|---|
| Normal | `durationSec = 4.2` | `actualDurationSec ≈ 4.2 + margem` (margem configurável, ex. +0,25 s) |
| Palavras fora de ordem | `words` com `start > end` ou sobrepostos | normaliza ou rejeita com erro claro — nunca legendas negativas |
| Duração zero | `durationSec = 0` | rejeita (segmento inválido) |
| Entrada por áudio | tempos vêm da transcrição | `actualDurationSec` = duração transcrita; sem gerar TTS |

### 3.2 Cache (round-trip)

- B-roll resolvido uma vez → 2.ª resolução do mesmo `visualKeywords`
  usa `outputs/cache/broll/` sem novo HTTP (teste com fake Pexels que
  conta requests: `requests === 1` para dois jobs iguais).
- Cache inválido/ficheiro em falta → volta a resolver, sem crash.

### 3.3 Validação da Spec (rejeita JSON mau)

Casos de rejeição (todos com mensagem pt-PT acionável):

- `version !== 1`; `segments` vazio; `id` duplicados ou fora de ordem.
- `narration` vazia; `targetDurationSec <= 0`.
- Soma das durações fora de ±20% da duração-alvo (quando pedida).
- JSON do LLM com chaves extra ou tipos errados (ex. `hookScore: "alto"`).
- Aceitação: Spec de exemplo do `ARCHITECTURE.md` §5 passa.

### 3.4 Jobs e API (contrato REST)

- `POST /api/jobs` → 201 com `Job` em `spec-draft`.
- `PUT /api/jobs/:id/spec` com Spec editada → `awaiting-approval`.
- `approveSpec` → `render` só corre após aprovação (sem aprovação, `render`
  rejeita).
- Erros no formato `{ error: { code, message } }`, `message` em pt-PT.
- SSE `GET /api/jobs/:id/events` emite `spec-draft → rendering → done`
  (teste com cliente SSE fake).

## 4. video — estratégia

Interface: `render(spec, opts): Promise<string>`,
`preview(spec): Promise<string>`.

### 4.1 Legendas karaoke — fronteiras de palavra ativa

A partir de `words[]` (tempos medidos, não estimados):

| Caso | Esperado |
|---|---|
| t = início exato de `word[i]` | palavra `i` ativa, `i-1` inativa |
| t no meio de `word[i]` | só `i` ativa |
| t em silêncio entre palavras | nenhuma ativa (ou última, conforme regra documentada — mas determinística) |
| `words` vazio | sem legendas, sem crash |
| Sobreposição de tempos | resolve para a palavra com maior sobreposição |

Testar a função pura que mapeia `t → palavra ativa` (ms), não o render.

### 4.2 Args FFmpeg — ducking + loudnorm

Teste de construção de comando (sem executar FFmpeg):

- O comando final contém filtro de **ducking** (música baixa sob a
  narração) e **loudnorm** (loudness consistente) — asserts sobre a string
  de args, não sobre o binário.
- `render()` com `crf`/`preset` customizados reflete-os nos args.
- B-roll mais curto que `actualDurationSec` → args incluem loop ou freeze
  (nunca `setpts` a esticar no tempo).

### 4.3 Render real (QA manual, Fase 4)

- `preview()` de 3 segmentos gera MP4 de baixa resolução reproduzível.
- `render()` de 30–60 s: B-roll + legendas + áudio sincronizados
  (ver checklist §7).

## 5. ui — estratégia (checklist manual)

A UI é web local (`http://localhost:3000`); nesta fase, verificação
manual guiada — **sem "sucesso falso"** (ver §5.3).

### 5.1 Wizard — 4 passos clicáveis

- [ ] Passo 1 (Origem): upload de áudio **ou** campo de tema + formato
      9:16/16:9 + idioma; botão seguinte só ativa com input válido.
- [ ] Passo 2 (Spec): lista de segmentos editável (narração,
      duração-alvo, keywords); "regenerar segmento" e "aprovar" funcionam.
- [ ] Passo 3 (Preview): play do MP4 de baixa resolução com legendas.
- [ ] Passo 4 (Render): progresso via SSE, download do MP4 no fim.
- [ ] Navegação para trás não perde edições da Spec.

### 5.2 Gates editáveis

- [ ] Nada renderiza sem aprovação explícita da Spec.
- [ ] Editar narração num segmento invalida preview/render anterior
      (estado volta a "por aprovar").
- [ ] Estado dos providers LLM visível (`GET /api/llm/status`); modo
      WebLLM e "Ollama local" selecionáveis.

### 5.3 Anti-fake (regra dura)

- [ ] Nenhum ecrã mostra "sucesso" sem artefacto real (ficheiro MP4 em
      disco / Spec validada).
- [ ] Erros de backend aparecem na UI com a mensagem pt-PT original.
- [ ] Falha de provider LLM mostra qual falhou e qual assumiu (failover
      visível, não silencioso demais para debug).

## 6. Checklist de QA manual — primeira run end-to-end (quando a Fase 2 chegar)

Pré-requisitos: `node scripts/doctor.mjs` com saída 0; `models:download`
executado; pelo menos um provider LLM alcançável (ou Ollama a correr).

1. `POST /api/jobs` com `{ kind: 'topic', topic: '…' }`, formato 9:16,
   `language: 'pt-PT'`.
2. `POST /api/jobs/:id/spec` → inspecionar a Spec: narração pt-PT,
   `hookScore` no 1.º segmento, JSON válido.
3. Editar uma narração via `PUT`, aprovar.
4. `POST /api/jobs/:id/render` → acompanhar SSE até `done`.
5. Verificar `outputs/final.mp4`: dura soma de `actualDurationSec`;
   legendas karaoke sincronizadas; áudio da voz Kokoro percetível.
6. Repetir com entrada de áudio real (60 s): transcrição com word
   timestamps corretos; `actualDurationSec` da transcrição.

## 7. Definition of Done por fase (critérios de QA)

| Fase | Done (verificável) |
|---|---|
| **1 — Fundações** | `npm run typecheck` passa em todos os workspaces; `doctor.mjs` saída 0 numa máquina limpa (avisos OK); router `npm test` verde; este TEST_PLAN revisto. |
| **2 — Voz e guião** | Job tema→Spec→TTS com `segments[].tts` e durações reais; transcrição de áudio 60 s com word timestamps corretos; `GET /health` dos serviços Python OK. |
| **3 — Imagem** | Preview de 3 segmentos com legendas sincronizadas, só com dados medidos; `PUT /api/jobs/:id/spec` + SSE funcionais. |
| **4 — Montagem** | MP4 9:16 de 30–60 s com B-roll, legendas e áudio, end-to-end sem intervenção após aprovação; cache de B-roll funcional. |
| **5 — Produto** | Joana produz um short 9:16 a partir de um tema em < 15 min de interação, num PC limpo, só com cliques; `doctor` guia a resolução de problemas em pt-PT. |

## 8. Riscos de QA observados

- **Kokoro pt-PT**: naturalidade da voz é risco conhecido (`ARCHITECTURE.md`
  §11) — validar com ouvintes humanos na Fase 2, não só com asserts.
- **Qualidade da Spec com LLMs gratuitos**: a validação estrita + revisão
  humana são o teste; registar taxa de rejeição da validação por provider.
- **Peso dos modelos**: `doctor` deve avisar de disco/RAM antes do
  `models:download` (a implementar na Fase 2/5).
- **WebLLM**: só testável com browser real; fora do âmbito da suite
  automática.

---

# Fase 2 — Voz e guião (adenda QA, 2026-10-06)

> Estado verificado contra a realidade (não contra planos): o serviço de
> transcrição está funcional e testado ao vivo; o serviço de TTS tem o
> servidor e os providers implementados mas ainda não correu com modelos
> reais neste ambiente; a API de orquestração `:3000` implementa o contrato
> congelado do `ARCHITECTURE.md` §8. Detalhe por secção abaixo.

## 9. Contractos dos serviços Python (testes automáticos)

Ficheiros: `packages/pipeline/test/pythonServices.contract.test.ts`
(cliente `ServiceClients` contra fakes locais — corre sempre, offline) e
os mesmos testes contra os serviços reais (saltados com motivo quando o
serviço não está a correr).

### 9.1 `ServiceClients` — formas exatas validadas

O cliente valida exatamente estas formas (`pythonBridge.ts`):

- `TranscriptionResult { text: string, words: Word[], language: string }`
- `TtsResult { audioPath: string, words: Word[], durationSec: number, voice: string }`
- `Word { word: string, start: number, end: number }`

Casos cobertos (fakes locais, sempre verdes):

| Caso | Esperado |
|---|---|
| `/transcribe` envia corpo | exatamente `{ audioPath }` — sem chaves extra |
| `/synthesize` envia corpo | exatamente `{ text, voice, rate, provider }` — **sem `language`** (divergência resolvida, `ARCHITECTURE.md` §4.4) |
| omissões do `/synthesize` | `provider: 'kokoro'`, `rate: 1.0` |
| resposta malformada (falta `words`, `durationSec`, etc.) | `Error` em pt-PT (`resposta inválida do serviço de …`) |
| serviço inalcançável | `Error` em pt-PT (`serviço de … indisponível`), sem hang |
| `health()` com serviços em baixo | `{ transcription: false, tts: false }` — nunca lança |

### 9.2 Serviços reais (ao vivo, quando a correr)

| Serviço | Verificado |
|---|---|
| `GET :8001/health` | 200 `{ ok: true, modelsLoaded: [...] }` ✅ (ao vivo) |
| `POST :8001/transcribe` áudio real (30 s de fala pt) | 200 `TranscriptionResult`: 53 palavras, `language: 'pt'`, todas com `{word,start,end}` e `end >= start` ✅ (ao vivo, faster-whisper `tiny`) |
| `POST :8001/transcribe` com `audioPath` inexistente | 404 `{ error: { code: 'audio_not_found', message } }` ✅ (ao vivo) |
| `GET :8002/health` | ⏳ serviço ainda não arranca neste ambiente (deps por instalar) — teste salta com motivo |
| `POST :8002/synthesize` kokoro / edge-tts | ⏳ idem — saltam com motivo |
| `POST :8002/synthesize` google | **mockado** (fake local, sem credenciais): valida a forma `TtsResult` e o `provider: 'google'` no fio ✅. Chamada real à cloud **nunca** na suite automática. |

Nota de ambiente (2026-10-06): `faster-whisper 1.2.1` chama
`av.open(..., metadata_errors="ignore")`, que o PyAV ≥ 14 (ex. 19.0.1)
**removeu** → `TypeError` e 500 `model_error`. Validado que `av==13.0.0`
funciona. O `requirements.txt` do TTS deve fixar `av<14` (ou equivalente)
antes do primeiro install real — ver relatório de QA.

## 10. Matriz de providers TTS + gates de validação

Providers por ordem canónica: `kokoro` → `edge-tts` → `google`
(`packages/tts/service/config.py: PROVIDER_ORDER`). Pedir um provider que
falhe faz fallback pelos restantes — nunca erro fatal enquanto houver
um provider capaz.

### 10.1 Gate de validação dos SSML marks (Google) — REGRA DURA

Implementado em `packages/tts/service/word_timing.py`
(`map_timepoints_to_words`); 17 testes pytest verdes
(`tests/test_word_timing.py`):

1. Cada palavra é envolvida em `<mark name="w{i}"/>` **antes** da palavra
   (`build_marked_ssml`; XML escapado).
2. `words[i].start = timepoints["w{i}"].time_seconds`;
   `words[i].end = words[i+1].start`; a última termina no `durationSec`
   **medido** do ficheiro.
3. **Gate**: se `len(timepoints) != len(palavras)` → descarta-se TUDO e
   vai-se para o fallback. Nunca se misturam timepoints parciais com
   estimativas. Timepoints fora de ordem ou com duração ≤ 0 também
   chumbam o gate.
4. `check_word_coverage` (corrigido pelo servidor antes de responder):
   timestamps ordenados, sem sobreposição, dentro dos limites do áudio,
   última palavra a terminar perto do `durationSec`.

### 10.2 Fallback obrigatório: faster-whisper

Se os marks falharem o gate (há registo de marcas perdidas após pontuação
em algumas vozes), o servidor corre o faster-whisper sobre o áudio gerado
(`whisper_retime.py`) — medido, nunca estimado. **Proibido** timing
uniforme (dividir duração pelo nº de palavras).

### 10.3 Por voz pt-PT candidata (manual, quando os providers correrem)

Para cada voz candidata (Kokoro, Edge-TTS `pt-PT-DuarteNeural` /
`pt-PT-RaquelNeural`, Google `pt-PT-Neural2-A` — nomes a confirmar):

- [ ] sintetizar parágrafo com pontuação variada (vírgulas, pontos,
      exclamações, números)
- [ ] assert `len(timepoints) == len(palavras)` no teste direto de marks
- [ ] registar que vozes passam no teste direto e quais precisam sempre
      do fallback faster-whisper
- [ ] confirmar que os `<mark/>` não alteram a prosódia (ouvir)

## 11. Checklist de escuta — voice samples para a Joana 🎧

Risco nº 1 do projeto (`ARCHITECTURE.md` §11): naturalidade do Kokoro em
pt-PT. Não há assert que substitua ouvidos humanos.

- [ ] gerar 3–5 amostras por voz candidata (Kokoro `pf_dora` + outras;
      Edge-TTS `pt-PT-DuarteNeural`, `pt-PT-RaquelNeural`): 2–3 frases com
      entoação variada (pergunta, exclamação, frase longa)
- [ ] a Joana ouve e classifica cada voz: naturalidade 1–5, sotaque
      (pt-PT vs pt-BR), artefactos (robotismo, cortes, pausas estranhas)
- [ ] fixar `KOKORO_VOICE` (e fallback Edge-TTS) no `.env` com base na
      escuta — não no default do código
- [ ] repetir a escuta se mudar o modelo/versão do Kokoro
- [ ] registar a decisão (voz escolhida + nota) no `docs/tts-providers.md`

## 12. Orquestração — checklist do fluxo de jobs (contrato §8)

Testes automáticos: `packages/pipeline/test/orchestration.contract.test.ts`
— **6/7 verdes ao vivo** contra `node dist/src/server.js` (`:3000`); o
ciclo completo salta sem LLM alcançável (sem chaves/Ollama neste
ambiente). Verificado ao vivo:

- [x] `POST /api/jobs` → 201 `{ job }`, `status: 'spec-draft'`
- [x] `GET /api/jobs/:id` desconhecido → 404 `{ error: { code, message } }`
      (mensagem em pt-PT)
- [x] `POST /api/jobs/:id/render` sem aprovação → 4xx com envelope de erro
- [x] `POST /api/jobs` com corpo inválido → 4xx com envelope de erro
- [x] `GET /api/jobs/:id/events` (SSE) — tipos dentro do conjunto
      congelado (`progress`, `spec-draft`, `awaiting-approval`,
      `rendering`, `done`, `failed`); cada evento traz `job`
- [x] `GET /api/llm/status` → `{ providers: [{ name, reachable, keyless }] }`
- [ ] ciclo completo tema → Spec → aprovação → render (requer LLM +
      TTS reais; fazer manualmente quando os serviços estiverem ligados)

Checklist manual (quando TTS + LLM estiverem ligados):

- [ ] `POST /api/jobs` (tema, 9:16, pt-PT) → `POST …/spec` → Spec válida
      com narração pt-PT
- [ ] `PUT …/spec` com narração editada → `awaiting-approval`
- [ ] `POST …/render` → 202 → acompanhar SSE até `done`
- [ ] `GET …/download` antes da Fase 4 → 409 honesto (sem MP4 inventado)
- [ ] repetir com entrada de áudio real: transcrição com word timestamps;
      `actualDurationSec` da transcrição

---

# Fase 3 — Imagem + B-roll + i18n (adenda QA, 2026-10-06)

> Estado verificado contra a realidade: a engenharia (b) entregou o
> resolvedor de B-roll (`packages/video/src/broll.ts`, 23 testes); a
> engenharia (c) entregou o catálogo de vozes (`packages/tts/voices.catalog.json`
> + `pipeline/src/voiceCatalog.ts` + `ui/src/lib/voices.ts` + seletor na UI),
> os orçamentos de legendas (`video/src/captions.ts`) e a opção de idioma no
> adaptador Hyperframes. A engenharia (a) ainda não ligou o preview real nem
> o `assemble()` (continuam stubs honestos: 501 / throw). **Regressão
> aberta**: `npm run typecheck` do `pipeline` falha em `src/orchestrate.ts:307`
> e `src/server.ts:219` (`exactOptionalPropertyTypes` vs a assinatura de
> `resolveTtsForJob`) — fix de uma linha no dono (ver relatório de QA).

## 13. Pipeline de render — estratégia (Fase 3a)

Ficheiros: `packages/pipeline/test/phase3-endpoints.contract.test.ts`
(12 testes, verdes).

### 13.1 Endpoints preview/download — matriz de contrato

| Caso | Esperado (verificado) |
|---|---|
| `GET …/download`, job `done` + MP4 real em disco | 200 `video/mp4`, bytes idênticos ao ficheiro, `Content-Disposition: attachment` |
| `GET …/download`, job em `rendering` | 409 `job_not_finished` (a mensagem diz o estado atual, pt-PT) |
| `GET …/download`, job `done` mas sem ficheiro | 409 `video_not_ready` (montagem Fase 4 ainda por implementar) |
| `GET …/download`, job desconhecido | 404 `job_not_found` |
| `POST …/download` | 405 `method_not_allowed` |
| `GET …/preview` (qualquer job) | **501 `not_implemented`** — stub honesto; este caso é o contrato ATUAL |

Regra de transição: quando a engenharia (a) ligar o preview real, o caso
501 é **substituído** (não apagado em silêncio) por: job com preview
gerado → 200 com o MP4 de baixa resolução; 404/409 honestos antes disso.
O happy path do download já testa bytes reais — nunca conteúdo inventado.

### 13.2 Aceitação dos quatro idiomas em `POST /api/jobs`

`POST /api/jobs` com `language` em `pt-PT | pt-BR | en | fr` → 201 e
`job.language` guarda a tag exata; omissão continua `pt-PT`. (Testes no
mesmo ficheiro de contrato.)

### 13.3 Por fazer (engenharia (a), Fase 3→4)

- `renderFrames()` por segmento após `buildFrames()` (o adaptador existe
  e está verificado; falta a chamada no fluxo do job).
- `assemble()` real (hoje lança `STUB` honestamente — teste
  `assemble is an unmistakable stub` no `ffmpeg.test.ts` fixa-o).
- `GET …/preview` real (baixa resolução) ligado ao passo de preview da UI.

## 14. B-roll — estratégia (Fase 3b) ✅ entregue

Implementação: `packages/video/src/broll.ts`. Testes do dono:
`packages/video/src/test/broll.test.ts` — **23 testes** (revistos pelo QA;
cobrem o contrato todo). A camada HTTP é mockada via `fetchImpl`
injetável — **zero chamadas à rede real** na suite.

### 14.1 Contrato verificado (cascata ARCHITECTURE.md §7)

| Caso | Esperado (verificado) |
|---|---|
| chave Pexels + API saudável | `provider: 'pexels'`, `clipId: 'pexels-<id>'`, `Authorization` com a chave, `orientation=portrait` para 9:16; clip sacado para `outputs/cache/broll/<clipId>.mp4`; `clipId` marcado no registo |
| Pexels 500/erro + chave Pixabay | cai para `provider: 'pixabay'` (fall-through silencioso mas registado no `log`) |
| sem chaves | **zero HTTP**; `provider: 'image'` — MP4 Ken Burns gerado de verdade pelo FFmpeg local |
| sem chaves e sem FFmpeg | `provider: 'template'`, `url: ''` — o `buildFrames()` usa a cor do template; **nunca vazio** |
| tudo falha | `resolveBroll` **nunca lança** — devolve sempre uma entrada válida (never-empty guarantee) |
| 2 segmentos, 1 clip | o 2.º não reutiliza o `clipId` (registo no-repeat por projeto, persistido em `broll-registry.json`) |
| 2.ª resolução do mesmo clip | **sem re-download** (cache hit por `clipId`) |
| `downloadToCache` com HTTP 403 | `false`, sem lançar |

### 14.2 Unidades puras verificadas

- `scoreCandidate`: duração exata → `durationFit` 1.0; 2× → 0.7 (corta-se,
  barato); metade → 0.375 (loop é pior que corte); portrait ganha em 9:16.
- `selectBestCandidate`: escolhe o melhor score; salta ids usados; `null`
  quando todos usados (a cascata continua).
- `buildSearchQuery`: keywords primeiro (máx 3); sem keywords → tokens da
  descrição; nunca vazio (`'abstract background'`).
- `UsedClipRegistry`: `mark`/`has` + persistência entre loads; ficheiro
  corrupto/ausente → começa vazio, sem crash.
- Builders de args FFmpeg (`buildGradientStillArgs`, `buildKenBurnsArgs`,
  `buildTemplateClipArgs`): determinísticos; zoompan cobre a duração toda.
- `kenBurnsVariant`: determinístico por `segment.id` (mesmo segmento →
  mesma variante).

### 14.3 Testes ao vivo (honestos, com skip)

`LIVE: Pexels/Pixabay search returns real candidates` — correm **só** com
`PEXELS_API_KEY`/`PIXABAY_API_KEY` no ambiente; sem chaves, saltam com
motivo explícito (nunca simulados). Fazer no PC da Joana quando houver
chaves gratuitas.

## 15. i18n — estratégia (Fase 3c) ✅ entregue (com 1 regressão aberta)

Fonte única de verdade: `packages/tts/voices.catalog.json` (lido pelo
pipeline TS, pelo serviço Python `voices_catalog.py` e pela UI).

### 15.1 Catálogo de vozes — contrato verificado

Ficheiro: `packages/pipeline/test/i18n-voices.contract.test.ts`
(17 testes, verdes contra a implementação real, na suite normal).

| Idioma | Default (verificado) | Porquê |
|---|---|---|
| pt-PT | edge-tts / `pt-PT-DuarteNeural` | o Kokoro **não tem** voz pt-PT — usar Kokoro aqui seria sotaque brasileiro silencioso (teste anti-regressão dedicado) |
| pt-BR | kokoro / `pf_dora` | a voz que a Joana adorou; local e grátis |
| en | kokoro / `af_heart` | voz inglesa do Kokoro mais bem avaliada |
| fr | kokoro / `ff_siwis` | **única** voz francesa do Kokoro-82M (confirmada em runtime: `models/kokoro/voices/ff_siwis.pt`); a Joana decide de ouvido |

Contrato verificado:
- `supportedLanguages()` → `[pt-PT, pt-BR, en, fr]` (ordem do catálogo = ordem da UI).
- `resolveTtsForJob({ language })` sem env/UI → default do idioma; com
  env (`TTS_ENGINE`/`KOKORO_VOICE`/…) → env vence; com escolha da UI
  (`engine`/`voice`) → UI vence tudo.
- A `chain` devolvida é a `fallbackChain` do catálogo; **a 1.ª entrada é
  sempre no idioma do job** (nunca muda de idioma em silêncio no 1.º salto;
  o `pf_dora` na cadeia pt-PT está documentado como "sotaque brasileiro,
  fallback quando não há rede" — explícito, não silencioso).
- Idioma desconhecido → `ApiError` 400 `unsupported_language` (pt-PT, lista
  os suportados); `TTS_ENGINE`/`SPEECH_RATE` inválidos → 500
  `invalid_tts_config`.
- `whisperLanguageCode('pt-PT')` → `'pt'` (hint do faster-whisper).
- Integridade: versão 1, 4 idiomas, vozes todas nomeadas, `verified` é
  booleano; **há vozes `verified: false`** (ver checklist manual abaixo).

### 15.2 Orçamentos de legendas — contrato verificado

Ficheiro: `packages/video/src/test/captions-i18n.contract.test.ts`
(8 testes, verdes). Funções puras em `video/src/captions.ts`.

| Base | `maxCharsPerLine` | `maxLines` | `fontScale` |
|---|---|---|---|
| pt (pt-PT, pt-BR) | 28 | 2 | 0.94 |
| fr | 30 | 2 | 0.96 |
| en (e omissão) | 34 | 2 | 1.0 |

- `getCaptionBudget`: `'PT-pt'`/`' fr '` → normaliza; desconhecido (`de`,
  `''`) → omissão inglês, sem crash; ordem documentada pt < fr < en.
- `wrapCaptionLines`: greedy, nunca excede o máximo, palavra maior que o
  máximo fica sozinha (nunca parte a meio), determinístico, sem perdas.
- `captionFontSizePx`: escala o `fontSizePx` do template pelo `fontScale`.
- ✅ Resolvido pela engenharia (c): `getCaptionBudget`/`wrapCaptionLines`/
  `captionFontSizePx` (e o tipo `CaptionBudget`) estão re-exportados no
  `packages/video/src/index.ts` (API pública).

### 15.3 UI — seletor de idioma e vozes (verificação manual)

Implementado: `ui/src/lib/voices.ts` + `StepInput` (seletor) + `StepVoice`
(voice picker por idioma/motor). Checklist manual:

- [ ] o seletor mostra os 4 idiomas pela ordem do catálogo, com labels pt-PT
- [ ] mudar de idioma repõe a voz omissa desse idioma (sem voz "pendurada" do idioma anterior)
- [ ] mudar de motor escolhe a 1.ª voz desse motor no idioma; se o motor não tem voz no idioma, volta à omissão do idioma
- [ ] `POST /api/jobs` recebe `{ tts: { engine, voice } }` da UI e o job resolve a voz certa (contrato servidor já coberto em `server.ts`)

### 15.4 Checklist manual — verificação de vozes no PC da Joana 🎧

As vozes `verified: false` vêm da documentação pública dos providers —
**têm de ser confirmadas em runtime** (a sandbox bloqueia o WebSocket do
Edge-TTS, por isso não deu para validar aqui). Ferramenta pronta:
`packages/tts/service/verify_voices.py`.

- [ ] correr `verify_voices.py` no PC da Joana e confirmar cada nome:
      `fr-FR-DeniseNeural`, `fr-FR-HenriNeural` (candidatas a omissão fr se
      a `ff_siwis` não convencer), `pt-BR-FranciscaNeural`,
      `pt-BR-AntonioNeural`, `en-US-AriaNeural`, `en-US-GuyNeural`,
      `pt-PT-Neural2-A`, `pt-BR-Neural2-A`, `en-US-Neural2-A`,
      `fr-FR-Neural2-A` (estas últimas só com credenciais Google)
- [ ] gerar amostras Edge-TTS em **francês** (2–3 frases com entoação
      variada: pergunta, exclamação, frase longa) e a Joana ouve e
      classifica: naturalidade 1–5, artefactos
- [ ] comparar `ff_siwis` (Kokoro, omissão fr atual) vs
      `fr-FR-DeniseNeural` — a Joana decide de ouvido qual fica como
      omissão; atualizar `defaultVoice`/`defaultProvider` de `fr` no
      `voices.catalog.json` em conformidade
- [ ] repetir para `pt-BR-FranciscaNeural` vs `pf_dora` (pt-BR já tem
      omissão Kokoro; confirmar que a Edge-TTS é fallback são)
- [ ] marcar `verified: true` no catálogo para cada nome confirmado e
      registar a decisão no `docs/i18n.md` §3–§4 (criado pela engenharia
      (c); o `$comment` do catálogo referencia-o)
- [ ] confirmar que os `<mark/>` SSML não alteram a prosódia das vozes fr
      (ouvir as amostras do teste de marks)

### 15.5 Regressão (resolvida no próprio dia)

Durante a escrita destes testes, o `npm run typecheck` do `packages/pipeline`
falhou (`src/orchestrate.ts:307`, `src/server.ts:219` — a assinatura de
`resolveTtsForJob` declarava `engine?: string` mas os call sites passam
`string | undefined` com `exactOptionalPropertyTypes`). Reportada ao dono
(engenharia (c)), que aplicou o fix sugerido (`engine?: string | undefined`)
e ainda adicionou os próprios testes em `test/voiceCatalog.test.ts`.
Lição de QA: regressões de typecheck em código partilhado quebram o
`npm test` do pacote inteiro (o `build` falha antes do `node --test`) —
o `typecheck` faz parte do "verde".
