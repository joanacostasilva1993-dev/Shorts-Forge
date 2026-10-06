# Arquitetura — shorts-forge

> Visão técnica do pipeline de geração de vídeos. Para o plano de trabalho,
> ver [ROADMAP.md](./ROADMAP.md). Tipos canónicos em
> `packages/shared/src/index.ts`.

## 1. Visão geral

O **shorts-forge** transforma **um áudio** (gravação tua) ou **um tema**
num vídeo pronto a publicar: vertical **9:16** (shorts) ou horizontal
**16:9** (vídeo longo). Tudo corre **localmente** no PC do utilizador,
orquestrado por uma interface web simples de poucos cliques.

A decisão arquitetural central é o **pipeline em duas fases**:

- **Fase A — plano:** o LLM gera a *Spec*, um guião plano-a-plano com
  durações-alvo, narração e palavras-chave visuais.
- **Fase B — execução fiel:** o TTS gera o áudio real de cada segmento e
  **cada plano é re-temporizado com os timestamps reais de cada palavra**.
  O render só acontece depois, com tempos medidos — não estimados.

Isto elimina a causa nº 1 de vídeos maus gerados por IA: o **drift entre o
guião planeado e o áudio real** (narração mais rápida/lenta que o previsto,
planos que acabam antes da frase, legendas dessincronizadas).

### Princípios

1. **Free-only por defeito.** Nenhuma API paga é necessária para o fluxo
   completo. Pagas são sempre opcionais e nunca bloqueiam o render.
2. **Medir, não estimar.** Durações vêm de áudio real (TTS ou transcrição),
   nunca de contagem de palavras.
3. **Local primeiro.** Transcrição (faster-whisper) e TTS (Kokoro) correm
   em Python no PC. O LLM prefere quotas gratuitas renováveis e tem
   backstop 100% local (Ollama) e modo browser (WebLLM).
4. **Contratos explícitos.** Os pacotes comunicam pelos tipos canónicos de
   `@shorts-forge/shared`; a UI comunica com o backend por REST.

## 2. O pipeline em duas fases (explicação prática)

### Fase A — o LLM escreve o plano (Spec)

Entrada: áudio transcrito **ou** tema + opções (formato, idioma, duração
aproximada, tom).

O `llm-router` pede ao LLM um JSON estrito que segue o tipo `Spec`:

```jsonc
{
  "version": 1,
  "title": "…",
  "format": "9:16",
  "language": "pt-PT",
  "segments": [
    {
      "id": "seg-01",
      "narration": "Texto que a voz vai dizer neste plano…",
      "visualKeywords": ["amanhecer", "cidade", "timelapse"],
      "brollDescription": "Timelapse do nascer do sol sobre uma cidade",
      "targetDurationSec": 4.5,
      "hookScore": 0.9,
      "hookLine": "Isto muda tudo"
    }
  ]
}
```

O pipeline valida o JSON (schema + regras: soma das durações dentro do
alvo, narração não vazia, ids únicos). **A UI mostra a Spec para revisão**:
a Joana pode editar narração, reordenar ou apagar segmentos antes de
avançar. Nada renderiza sem aprovação — a Spec é o contrato do vídeo.

> `targetDurationSec` é uma **intenção**, não uma promessa. A duração real
> só é conhecida na Fase B.

### Fase B — TTS, re-temporização e render

Para cada segmento, por ordem:

1. **TTS** (Kokoro, local): gera `audioPath` + `words[]` (timestamps por
   palavra) + `durationSec` reais → preenche `segment.tts`.
2. **Re-temporização:** `actualDurationSec = tts.durationSec`
   (+ pequena margem de respiro configurável, ex. +0,25 s no fim).
   O plano passa a ter a duração do áudio real — o drift desaparece aqui.
3. **B-roll:** resolve-se um clip com duração ≥ `actualDurationSec`
   (ver §7); se for mais comprido, corta-se; se for mais curto, faz-se
   loop ou congela-se o último frame (decisão de montagem, não de plano).
4. **Legendas:** com `words[]` do TTS, geram-se legendas palavra-a-palavra
   (estilo karaoke) alinhadas ao milissegundo — grátis, porque os tempos
   já existem.
5. **Render:** o pacote `video` monta a timeline (Hyperframes para os
   frames com HTML/CSS + FFmpeg para composição, áudio e codificação
   final).

Caso especial — **entrada por áudio**: em vez de TTS, usa-se a transcrição
(faster-whisper). O LLM (Fase A) recebe o texto transcrito **com os tempos
reais** e escreve a Spec já alinhada a esses tempos; a Fase B então só
confirma (`actualDurationSec` vem da transcrição) em vez de gerar voz. O
mecanismo é o mesmo: tempos medidos, não estimados.

### Diagrama do fluxo end-to-end

```
                    ┌──────────────────────────────────────────────┐
                    │                    UI (web local)             │
                    │  origem → rever Spec → preview → render final │
                    └──────┬───────────────────────────────┬───────┘
                           │ POST /api/jobs                │ GET /api/jobs/:id (SSE)
                           ▼                               │
┌──────────────────────────────────────────────────────────────────┐
│                         pipeline (orquestrador)                   │
│                                                                  │
│  ┌─ FASE A ──────────────────────────────────────────────────┐   │
│  │ 1. input: áudio → transcription → texto+tempos            │   │
│  │         tema    → (direto)                                 │   │
│  │ 2. llm-router.chat(jsonMode) → Spec (validada)             │   │
│  │ 3. devolve Spec à UI para revisão/edição ─┐               │   │
│  └──────────────────────────────────────────│────────────────┘   │
│                                             │ utilizador aprova  │
│  ┌─ FASE B ─────────────────────────────────▼────────────────┐   │
│  │ 4. tts por segmento → audioPath + words[] + durationSec    │   │
│  │ 5. re-temporização: actualDurationSec = duração real       │   │
│  │ 6. b-roll: resolver clip ≥ actualDurationSec               │   │
│  │ 7. video: Hyperframes (frames HTML/CSS) + legendas karaoke │   │
│  │ 8. video: FFmpeg compõe timeline → outputs/final.mp4       │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
        │                    │                     │
        ▼                    ▼                     ▼
  llm-router            transcription            tts
  (cadeia c/           (faster-whisper,        (Kokoro,
   failover)            Python local)           Python local)
```

## 3. Mapa de módulos

Monorepo npm workspaces (`packages/*`). Cada pacote tem **uma**
responsabilidade e expõe uma interface mínima.

| Pacote | Responsabilidade | Não faz |
|---|---|---|
| `shared` | Tipos canónicos (`Word`, `Segment`, `Spec`, `ChatRequest`, …). Contrato entre todos. | Lógica. Só tipos. |
| `llm-router` | `chat(req: ChatRequest): Promise<ChatResult>` com cadeia de providers + failover. Escolhe provider, gere quotas/429, faz retry. Expõe também modo browser (WebLLM). | Prompts de produto (isso é do `pipeline`). |
| `pipeline` | Orquestra as Fases A e B. Valida a Spec (JSON schema + regras). Gere jobs (estado, progresso, SSE). Expõe a API REST usada pela UI. | TTS, transcrição, render — delega. |
| `transcription` | Serviço Python (faster-whisper): áudio → `TranscriptionResult` (texto + `words[]` + idioma). | Nada de LLM. |
| `tts` | Serviço Python: texto → `TtsResult` (ficheiro áudio + `words[]` + duração + voz). Providers: Kokoro (local, omissão), Edge-TTS, Google Cloud TTS. | Nada de render. |
| `video` | Templates Hyperframes (HTML/CSS → frames), legendas karaoke a partir de `words[]`, B-roll (ver §7), montagem final FFmpeg. | Nada de áudio/LLM. |
| `ui` | Web app local: 4 passos (origem → Spec → preview → render), editor da Spec, pré-visualização, progresso via SSE. | Lógica de pipeline — chama a API. |

Dependências (setas = "importa de"):

```
ui ──REST──▶ pipeline ──▶ llm-router ──▶ shared
                  ├─────▶ transcription ─▶ shared
                  ├─────▶ tts ───────────▶ shared
                  └─────▶ video ─────────▶ shared
```

Serviços Python (`transcription`, `tts`) correm como **processos locais**
geridos pelo `pipeline` (spawn) e falam por **HTTP local** (loopback) ou
stdio JSON — decisão de implementação na Fase 2; o contrato de dados é o
`TranscriptionResult`/`TtsResult` do `shared`.

## 4. Interfaces dos módulos

### 4.1 `shared` — os tipos canónicos

Definidos em `packages/shared/src/index.ts` (implementados verbatim;
documentados com TSDoc em inglês). Resumo dos principais:

- `Word { word, start, end }` — palavra com timestamps (segundos).
- `VideoFormat = '9:16' | '16:9'`.
- `Segment` — um plano: `id`, `narration`, `visualKeywords`,
  `brollDescription`, `targetDurationSec`, opcionais `hookScore`/`hookLine`;
  Fase B preenche `tts`, `broll`, `actualDurationSec`.
- `Spec { version: 1, title, format, language, segments }`.
- `ChatMessage`, `ChatRequest { messages, jsonMode?, maxTokens?, timeoutMs? }`,
  `ChatResult { text, provider, model }`.
- `ProviderConfig { name, baseUrl, apiKeyEnv?, models[], priority, keyless? }`,
  `RouterConfig { providers }`.
- `TranscriptionResult { text, words, language }`,
  `TtsResult { audioPath, words, durationSec, voice }`.
- `PipelineInput = { kind: 'audio', audioPath } | { kind: 'topic', topic }`.

> Nota: o `PipelineInput` canónico está declarado como `type` (união),
> não `interface` — interfaces TypeScript não suportam uniões. A forma é
> idêntica para quem importa.

### 4.2 `llm-router`

```ts
// packages/llm-router/src/index.ts (proposto)
import type { ChatRequest, ChatResult, RouterConfig } from '@shorts-forge/shared';

export interface LlmRouter {
  /** Uma completion; faz failover pela cadeia até um provider responder. */
  chat(req: ChatRequest): Promise<ChatResult>;
  /** Providers disponíveis neste momento (para a UI mostrar estado). */
  status(): Promise<ProviderStatus[]>;
}
export interface ProviderStatus {
  name: string; reachable: boolean; keyless: boolean;
  quotaHint?: string; // ex. "429 há 2 min" — informativo
}
export function createRouter(config: RouterConfig): LlmRouter;
```

Detalhes do desenho em §6.

### 4.3 `pipeline`

```ts
// packages/pipeline/src/index.ts (proposto)
import type { PipelineInput, Spec } from '@shorts-forge/shared';

export type JobStatus = 'spec-draft' | 'awaiting-approval' | 'rendering' | 'qc' | 'qc-failed' | 'done' | 'failed';
// 'qc' / 'qc-failed': etapa de QC automático da Fase 4 (ver §8.1) —
// extensão intencional do contrato original da Fase 1.
export interface Job { id: string; status: JobStatus; input: PipelineInput; spec?: Spec; progress: number; error?: string; }

export interface Pipeline {
  createJob(input: PipelineInput, opts: { format: VideoFormat; language: string }): Promise<Job>;
  generateSpec(jobId: string): Promise<Spec>;          // Fase A
  approveSpec(jobId: string, spec: Spec): Promise<Job>; // utilizador edita e aprova
  render(jobId: string): Promise<Job>;                  // Fase B
  getJob(jobId: string): Promise<Job>;
  specEvents(jobId: string): AsyncIterable<JobEvent>;   // para SSE
}
```

### 4.4 `transcription` / `tts` (serviços Python)

Contrato HTTP local (proposto):

```
POST /transcribe  { audioPath } → TranscriptionResult
POST /synthesize  { text, voice, rate, provider } → TtsResult
GET  /health     → { ok: true, modelsLoaded: [...] }
```

> Contrato do `/synthesize` resolvido (especialista TTS, 2026-10-05): a
> versão anterior propunha `{ text, voice, language }`; o contrato final é
> `{ text, voice, rate, provider }` com
> `provider: 'kokoro' | 'edge-tts' | 'google'` (omissão `'kokoro'`).
> `rate` ganhou a `language` porque a UI já expõe velocidade e o Google
> mapeia `rate`→`speakingRate`; o idioma está codificado no nome da voz
> (ex. vozes `pt-PT-*`). Detalhes em `docs/tts-providers.md`.

O `pipeline` faz spawn dos processos e gere o ciclo de vida (arranque
preguiçoso, paragem no fim do job ou timeout de inatividade).

### 4.5 `video`

```ts
// packages/video/src/index.ts (proposto)
import type { Spec } from '@shorts-forge/shared';

export interface RenderOptions { outPath: string; crf?: number; preset?: string; }
export interface VideoRenderer {
  /** Renderiza a Spec (já re-temporizada) para MP4 final. */
  render(spec: Spec, opts: RenderOptions): Promise<string>; // devolve outPath
  /** Preview rápido de baixa resolução para a UI. */
  preview(spec: Spec): Promise<string>;
}
```

Internamente: Hyperframes gera os frames a partir de templates HTML/CSS
(texto, hook, legendas karaoke com `words[]`); FFmpeg compõe B-roll +
frames + áudio TTS e codifica.

### 4.6 `ui`

Web app local (framework a decidir na Fase 5; servir em
`http://localhost:3000`). Quatro ecrãs:

1. **Origem** — upload de áudio ou campo de tema + formato (9:16/16:9) +
   idioma.
2. **Guião (Spec)** — lista de segmentos editável (narração, duração-alvo,
   palavras-chave); botões "regenerar segmento" e "aprovar".
3. **Preview** — render de baixa resolução, com play.
4. **Render final** — progresso, download do MP4.

## 5. Formato de dados Spec (exemplo completo)

```json
{
  "version": 1,
  "title": "3 hábitos que mudam as tuas manhãs",
  "format": "9:16",
  "language": "pt-PT",
  "segments": [
    {
      "id": "seg-01",
      "narration": "Acordas, pegas no telemóvel e já perdeste. Há uma forma melhor de começar o dia.",
      "visualKeywords": ["despertador", "manhã", "cama"],
      "brollDescription": "Mão a desligar um despertador de manhã cedo, luz suave",
      "targetDurationSec": 5.0,
      "hookScore": 0.95,
      "hookLine": "Larga o telemóvel"
    },
    {
      "id": "seg-02",
      "narration": "Primeiro hábito: luz natural nos primeiros dez minutos. Diz ao teu cérebro que o dia começou.",
      "visualKeywords": ["janela", "luz do sol", "café da manhã"],
      "brollDescription": "Pessoa a abrir a janela com sol da manhã a entrar",
      "targetDurationSec": 6.5
    }
  ]
}
```

Regras de validação (pipeline, Fase A):

- `version === 1`; `segments.length >= 1`; `id` únicos e ordenados.
- `narration` não vazio; `targetDurationSec > 0`.
- Soma das durações dentro de ±20% da duração-alvo pedida (se pedida).
- Após a Fase B: todos os segmentos têm `tts`, `broll` e
  `actualDurationSec`; a duração total do vídeo = soma de
  `actualDurationSec`.

## 6. Desenho do router de LLMs

O `llm-router` é construído por um especialista dedicado; aqui fica o
desenho acordado para convergência.

### 6.1 Cadeia de providers com failover

`RouterConfig.providers` ordenado por `priority` (menor primeiro). Para
cada `chat()`:

```
para cada provider (por prioridade):
  para cada model do provider (por ordem):
    tentar request (timeoutMs, jsonMode quando suportado)
    sucesso → devolve ChatResult { text, provider: name, model }
    429/5xx/timeout → regista, passa ao próximo
todos falharam → erro agregado (lista o que falhou e porquê)
```

### 6.2 Gastar quotas renováveis primeiro

Ordem canónica (a implementada em `packages/llm-router/src/providers.ts`;
ajustável por config):

1. **Gemini** (chave gratuita) — quota gratuita generosa, boa qualidade
   para gerar a Spec.
2. **Groq** (chave gratuita) — rápido, quota diária renovável.
3. **OpenRouter `:free`** (chave gratuita) — modelos free rotativos.
4. **Mistral / Cerebras / GitHub Models** (chaves gratuitas) — redundância.
5. **Pollinations** (keyless) — sem chave, sem conta; fallback de
   zero-configuração.
6. **Ollama** (local, `http://localhost:11434`) — **backstop final**:
   funciona offline, sem quotas, sem chaves.

Racional: quando há chaves gratuitas configuradas, gastam-se primeiro as
quotas renováveis (melhor qualidade para a Spec); sem chaves, o router
salta-os silenciosamente e a cadeia efetiva fica Pollinations → Ollama —
ou seja, **zero configuração continua a funcionar**. O modo keyless nunca
é descartado, fica como rede de segurança antes do backstop local.

Lógica de 429: backoff com jitter + marcação temporal do provider
("arrefecimento" curto); o router salta providers em arrefecimento mas
volta a tentar quando expira — quotas renováveis voltam, por isso não são
descartados permanentemente.

### 6.3 Modo browser (WebLLM)

Terceira opção na UI, ao lado de "automático" e "Ollama local": corre um
modelo pequeno (WebGPU) **no browser do utilizador**, sem chave e sem
servidor. Útil quando não há chaves nem Ollama instalado. O `llm-router`
expõe o adaptador; a UI carrega o modelo e o `pipeline` trata-o como mais
um provider (com latência maior — avisada na UI).

### 6.4 Configuração

`RouterConfig` vem de ficheiro + env (nunca chaves no código):

```jsonc
// config/llm-router.json (exemplo; prioridades = ordem canónica do §6.2)
{ "providers": [
  { "name": "gemini", "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
    "apiKeyEnv": "GEMINI_API_KEY", "models": ["gemini-2.0-flash"], "priority": 10 },
  { "name": "groq", "baseUrl": "https://api.groq.com/openai/v1",
    "apiKeyEnv": "GROQ_API_KEY", "models": ["llama-3.3-70b-versatile"], "priority": 20 },
  { "name": "pollinations", "baseUrl": "https://text.pollinations.ai/openai",
    "apiKeyEnv": null, "keyless": true, "models": ["openai"], "priority": 70 },
  { "name": "ollama", "baseUrl": "http://localhost:11434/v1",
    "apiKeyEnv": null, "models": ["llama3.1"], "priority": 100 }
]}
```

Todos falam **OpenAI-compatible** (`/chat/completions`) — um só cliente
HTTP serve todos os providers.

## 7. Estratégia de B-roll

Cada segmento traz `visualKeywords` + `brollDescription` da Fase A. Na
Fase B, o `video` resolve por esta ordem:

1. **Pexels / Pixabay** (se houver chave no `.env`) — pesquisa por
   `visualKeywords`, escolhe clip com `durationSec >= actualDurationSec`.
   Cache local em `outputs/cache/broll/` por `clipId`.
2. **Fallback sem chave** — imagens locais (o `Segment.broll.provider`
   passa a `'image'`): Ken Burns (zoom/pan lento via FFmpeg/Hyperframes)
   sobre foto livre para preencher `actualDurationSec`.
3. **Último recurso** — fundo gerado pelo template (gradiente + tipografia
   do hook), sem dependência externa.

Regras de montagem: clip mais comprido → corta-se ao `actualDurationSec`;
clip mais curto → **loop suave com crossfade (omissão)** ou freeze do
último frame (nunca esticar no tempo, que cria artefactos) — decisão
resolvida na Fase 4: a omissão é `'loop'`, configurável por projeto via
`shortClipStrategy: 'loop' | 'freeze'` no `Job` (`POST /api/jobs`); o
clip original fica intacto na cache e o fit é um derivado
determinístico, por isso a escolha é reversível. A atribuição final fica
em `segment.broll` (`provider`, `clipId`, `url`, `durationSec`, mais
`shortClipStrategy` quando houve fit). Detalhes em `docs/broll.md`.

## 8. Contratos API — UI ↔ backend

Base: `http://localhost:3000/api` (mesmo processo/origem da UI). Eventos
de progresso via **SSE**.

```
POST   /api/jobs
  body: { input: PipelineInput, format: VideoFormat, language: string,
          preset?: PlatformPresetId, tts?: { engine?: string; voice?: string } }
  → 201 { job: Job }
  # preset (opcional): tiktok | youtube-shorts | youtube-long |
  #   instagram-reels. Quando presente, ganha sobre `format` e impõe a sua
  #   proporção; sem preset, o format resolve para o preset omisso
  #   (9:16 → youtube-shorts, 16:9 → youtube-long). Detalhes em
  #   docs/platforms.md.

POST   /api/jobs/:id/spec            # Fase A
  → 200 { spec: Spec }  (também emite SSE job:spec-draft)

GET    /api/jobs/:id                 → 200 { job: Job }
GET    /api/jobs/:id/events          # SSE: progress, spec-draft, rendering, qc, qc-failed, done, failed
PUT    /api/jobs/:id/spec
  body: { spec: Spec }               # utilizador edita/aprova
  → 200 { job: Job }                 # status → awaiting-approval → pronto

POST   /api/jobs/:id/render          # Fase B
  → 202 { job: Job }                 # status → rendering (também aceite a partir de qc-failed: recomeça a Fase B)

POST   /api/jobs/:id/retry-qc        # repete SÓ o QC de um job qc-failed (ver §8.1)
  → 202 { job: Job }                 # status → qc (usa o final.mp4 existente)

GET    /api/jobs/:id/qc-report        → 200 { report }  # relatório do QC (ver §8.1); 404 se ainda não correu
GET    /api/jobs/:id/download        → MP4 final (só quando done; 409 honesto caso contrário)
                                     # qc-failed → 409 qc_failed: o vídeo mau NUNCA é servido
GET    /api/jobs/:id/preview         → MP4 de preview (baixa resolução)

GET    /api/llm/status               → { providers: ProviderStatus[] }
POST   /api/llm/chat                 # debug/manual; body: ChatRequest → ChatResult
```

Erros: `{ error: { code: string, message: string } }` com HTTP adequado;
`message` sempre em pt-PT (a UI mostra-o tal qual).

### 8.1 Etapa de QC automático (Fase 4)

Entre o render e o `done` há uma etapa automática de **controlo de
qualidade** (`packages/pipeline/src/qc.ts`). O ciclo de vida passa a ser:

```
rendering → qc → done
              ↘ qc-failed  (com motivos em pt-PT em job.error)
```

**Extensão intencional do contrato da Fase 1:** os estados `qc`
(em curso) e `qc-failed` (terminal) foram acrescentados ao `JobStatus` e
aos tipos de evento SSE. A justificação: servir um vídeo com defeito
seria pior do que alargar o contrato — e o `/download` agora recusa
qualquer job que não esteja `done` (409 honesto, com código `qc_failed`
e os motivos no corpo).

As 9 verificações (todas reais, via ffprobe/filtros FFmpeg sobre o
`final.mp4`; se a ferramenta falhar, o check chumba — nunca passa "por
defeito"):

| # | Check | Regra | Racional do limiar |
|---|---|---|---|
| 1 | `audio-present` | stream de áudio existe **e** ≥ 1.0 s de áudio não-silencioso (silencedetect a −40 dB) | 1.0 s distingue "narração presente" de "ficheiro mudo"; −40 dB ignora ruído de fundo do codec |
| 2 | `duration` | duração real dentro de max(±1.5 s, ±5%) da soma de `actualDurationSec` | ±1.5 s cobre arredondamentos de contentor/codec em vídeos curtos; ±5% escala para vídeos longos |
| 3 | `captions` | `captions.srt` existe e nº de palavras dentro de max(5, ±5%) das palavras narradas | 5 palavras absorve diferenças de tokenização; ±5% escala |
| 4 | `no-black` | nenhum preto contínuo > 1.0 s (blackdetect) | 1.0 s: abaixo disso pode ser transição; acima é plano sem imagem |
| 5 | `no-freeze` | nenhuma imagem parada > 1.0 s (freezedetect) | idem — frame preso indica B-roll falhado |
| 6 | `loudness` | integrada em −16 LUFS ± 2 | −16 LUFS é o alvo que a montagem já usa no `loudnorm`; ±2 dá margem ao loudnorm de passagem única e às plataformas |
| 7 | `no-clipping` | pico máximo < 1.0 (0 dBFS) no astats | ≥ 1.0 = amostras a fundo de escala = distorção digital real |
| 8 | `no-unexpected-silence` | nenhum silêncio > 0.8 s dentro do span narrado que a Spec (words[] reais do TTS) não prevê | 0.8 s: pausas naturais de respiração ficam abaixo; um buraco de TTS (frase cortada, glitch) fica acima. **Limitação:** analisa a mistura final — com música de fundo a sensibilidade baixa |
| 9 | `no-abrupt-cut` | **AVISO** (nunca chumba): queda/subida brusca de energia (volumedetect em janelas de 0.1 s; "há energia" ≥ −20 dB, "há silêncio" ≤ −45 dB) numa fronteira de segmento | fronteiras costumam cair em silêncio (margens de respiro); um cliff aí é quase sempre corte seco na montagem |

**Âmbito honesto (princípio da Joana: naturalidade da voz = critério
nº 1):** nenhum algoritmo deteta "roboticidade" de forma fiável, por
isso o QC **não** calcula nenhum "score de naturalidade" — seria fingir
medição. A gate humana de aprovação de vozes continua a ser o árbitro da
naturalidade; o QC apanha apenas artefactos mensuráveis (distorção,
buracos, cortes). Para diagnóstico, o `qc-report.json` inclui o
`provider` e a `voice` de TTS usados no job e o resumo por segmento.

O relatório é escrito em `outputs/<jobId>/qc-report.json`
(`schema: "shorts-forge/qc-report"`, `version: 1` — formato estável para
a biblioteca de projetos da Fase 6 referenciar no `project.yaml`).

**Recuperação de um `qc-failed`** (caminho honesto, sem aprovações
manuais silenciosas):
- `POST /api/jobs/:id/retry-qc` — repete só o QC sobre o `final.mp4`
  existente (útil se o ficheiro foi corrigido por fora ou um check
  falhou de forma transitória). Volta a `qc` e depois a `done` ou
  `qc-failed`.
- `POST /api/jobs/:id/render` — a partir de `qc-failed` recomeça a
  Fase B completa (novo TTS + montagem + QC). Limpa o erro e o vídeo
  rejeitado, para o `/download` nunca servir o ficheiro mau.

## 9. Política free-only (vinculativa)

- **Nada do fluxo principal exige API paga.** ElevenLabs, OpenAI paga,
  e afins **nunca** são requisito.
- Provedores pagos podem existir como **adaptadores opcionais**
  (ex. ElevenLabs para TTS premium), mas:
  - desligados por defeito;
  - nunca no caminho crítico — o pipeline funciona a 100% sem eles;
  - claramente marcados na UI como "opcional/pago".
- B-roll por API com chave (Pexels/Pixabay têm tier gratuito) é opcional;
  o fallback local cobre a ausência.
- Modelos locais (whisper, Kokoro, Ollama) são sacados pelo script
  `doctor`/setup — sem conta, sem chave.

## 10. Decisões registadas

| # | Decisão | Motivo |
|---|---|---|
| 1 | Pipeline em duas fases com Spec intermédia | Elimina drift script↔áudio; dá ponto de revisão humana |
| 2 | Re-temporização com timestamps reais de palavras | Legendas karaoke e cortes exatos "de graça" |
| 3 | Tipos canónicos num pacote `shared` | Contrato único entre equipas paralelas |
| 4 | Router OpenAI-compatible para todos os providers | Um cliente HTTP, N providers |
| 5 | Serviços Python como processos locais (spawn) | faster-whisper e Kokoro são ecossistema Python |
| 6 | Hyperframes para frames + FFmpeg para montagem | Templates HTML/CSS reutilizáveis; FFmpeg é o standard de composição |
| 7 | UI web local em vez de CLI | "Poucos cliques" exige UI; API REST permite CLI futura |
| 8 | **Naturalidade da voz = critério nº 1** (Joana, 2026-10-06) | O áudio gerado NÃO pode soar robótico; vozes neurais (Edge-TTS Neural, Google WaveNet/Neural2) têm prioridade mesmo exigindo rede. O modo 100% local passa a alternativa de robustez, não a omissão, quando há conflito. Exceção da Fase 3 ("omissão não exige rede") cai por decisão consciente da Joana — o free-only (nada pago no caminho crítico) mantém-se |

## 11. Riscos e mitigação

- **Qualidade do LLM gratuito para a Spec** — mitigação: validação
  estrita + revisão humana obrigatória + regenerar por segmento.
- **Kokoro pt-PT** — validar na Fase 2 a naturalidade da voz portuguesa;
  fallback: outra voz/esforço de fine-tuning descartado por agora.
- **Peso dos modelos locais** — `doctor` verifica disco/RAM/GPU e sugere
  variantes (whisper `small` vs `medium`).
- **WebLLM no browser** — só para Specs curtas; avisar latência na UI.
