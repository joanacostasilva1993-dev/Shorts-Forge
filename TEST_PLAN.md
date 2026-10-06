# Plano de Testes — shorts-forge (QA)

> Âmbito: **Fase 1** (fundações). Cobertura dos contratos documentados em
> `ARCHITECTURE.md`; os pacotes `pipeline`, `video` e `ui` estão em
> construção em paralelo, por isso as estratégias abaixo visam as
> **interfaces documentadas**, não o código ainda inacabado.
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
