# Providers de TTS — shorts-forge

> Estado: contrato do cliente TypeScript finalizado (`packages/pipeline/src/pythonBridge.ts`).
> Os SERVIDORES Python (Kokoro, Edge-TTS, Google) chegam na **Fase 2**.
> Identificadores de código em inglês; este documento em pt-PT.

## 1. Visão geral

O shorts-forge suporta três providers de texto-para-fala, selecionáveis na UI:

| Provider | Omissão? | Custo | Chave | Vozes pt-PT | Word timestamps |
|---|---|---|---|---|---|
| **Kokoro** | ✅ omissão | local, grátis | nenhuma | sim (a confirmar na Fase 2) | nativos (a confirmar na Fase 2) |
| **Edge-TTS** | fallback | grátis | nenhuma | sim | via SSML marks (a confirmar na Fase 2) |
| **Google Cloud TTS** | opcional | tier grátis generoso, depois pago por carácter | `GOOGLE_TTS_API_KEY` **ou** `GOOGLE_APPLICATION_CREDENTIALS` | sim | via SSML `<mark>` + `enable_time_pointing` (ver §4) |

Regras que não mudam:

- **Kokoro continua a omissão**: fluxo completo funciona a 100% sem chaves e sem internet (política free-only, ARCHITECTURE.md §9).
- Google Cloud TTS é **first-class mas opcional**: aparece na UI como terceira opção, nunca no caminho crítico. Sem credenciais configuradas, o provider fica indisponível e o pipeline usa Kokoro/Edge-TTS.
- Os três providers devolvem o mesmo `TtsResult` canónico (`audioPath`, `words[]`, `durationSec`, `voice`) — ver contrato final no §3.

## 2. Comparação detalhada

### Kokoro (omissão — local, grátis, sem chave)

- Corre em Python no PC, sem rede e sem conta.
- Vozes pt-PT a validar na Fase 2 (naturalidade do português europeu — risco já registado no ARCHITECTURE.md §11).
- Devolve timestamps por palavra nativamente (a confirmar contra a versão do Kokoro usada na Fase 2; se não devolver, aplica-se o mesmo fallback faster-whisper do §4.3).
- Variável: `KOKORO_VOICE` (nome da voz no catálogo Kokoro).

### Edge-TTS (fallback grátis)

- Serviço gratuito da Microsoft, sem chave, via rede.
- Tem vozes pt-PT (exemplos — **verificar nomes exatos na Fase 2**: `pt-PT-DuarteNeural`, `pt-PT-RaquelNeural`).
- Não garante word timestamps nativos; a Fase 2 pode usar SSML marks (mesma técnica do §4) ou faster-whisper.

### Google Cloud TTS (nova opção first-class)

- API cloud da Google; a Joana já tem acesso.
- Tier grátis mensal generoso por classe de voz (Standard > WaveNet/Neural2; Studio/Chirp 3 têm condições próprias). **Os valores mudam com frequência — confirmar na [página de preços](https://cloud.google.com/text-to-speech/pricing) no momento do build.**
- Vozes pt-PT em várias classes (Standard, WaveNet, Neural2, Studio, Chirp 3: HD). Exemplos — **são só exemplos, verificar nomes exatos na Fase 2** via `GET https://texttospeech.googleapis.com/v1/voices?languageCode=pt-PT`:
  - `pt-PT-Standard-A`
  - `pt-PT-Wavenet-A`
  - `pt-PT-Neural2-A`
- Variável: `GOOGLE_TTS_VOICE` (nome exato da voz, ex. `pt-PT-Neural2-A`).

## 3. Autenticação Google Cloud TTS

Duas formas suportadas; **nunca as duas ao mesmo tempo no código** (só no `.env`):

| Variável | O que é | Quando usar |
|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | Caminho para o JSON da service account (ex. `/home/joana/.gcp/shorts-forge-tts.json`) | Recomendado quando já usas Google Cloud / ADC; fluxos server-to-server, quotas e monitorização por projeto |
| `GOOGLE_TTS_API_KEY` | Chave de API simples (Console → APIs & Services → Credentials) | Mais simples; suficiente para o TTS; ideal para começar |

**Precedência** (implementar assim na Fase 2): se `GOOGLE_APPLICATION_CREDENTIALS` estiver definida **e o ficheiro existir**, usa-se a service account; senão, usa-se `GOOGLE_TTS_API_KEY`; se nenhuma estiver definida, o provider `google` responde indisponível e o pipeline faz fallback para Kokoro/Edge-TTS (sem erro fatal).

Notas:

- Ambas exigem um projeto Google Cloud com a **Cloud Text-to-Speech API ativada**.
- Valores de exemplo no `.env.example` são marcadores — nunca chaves reais; o `.env` real está no `.gitignore`.
- A chave de API segue no pedido REST (`?key=` ou header `x-goog-api-key`); a service account usa OAuth2 (biblioteca `google-cloud-texttospeech` trata disso).

## 4. Contrato final do `/synthesize` (divergência resolvida)

O pipeline sinalizou uma divergência: o ARCHITECTURE.md §4.4 propunha
`POST /synthesize { text, voice, language }`, mas o `pythonBridge.ts` enviava
`{ text, voice, rate }`.

**Decisão final (vinculativa para a Fase 2):**

```
POST /synthesize
  { "text": string, "voice": string, "rate": number, "provider": "kokoro" | "edge-tts" | "google" }
  → TtsResult { audioPath, words[], durationSec, voice }
```

Racional:

- `rate` ganha a `language`: a UI já expõe um slider de velocidade (0,8×–1,2×), e o Google mapeia-o diretamente para `speakingRate` no `audioConfig`. Remover `rate` partia a UI.
- `language` é redundante: o idioma está codificado no **nome da voz** (ex. vozes `pt-PT-*`). O servidor infere o idioma da voz pedida.
- `provider` (novo, opcional, omissão `'kokoro'`) seleciona o motor no servidor Python. Mapeamento com a UI: `kokoro → kokoro`, `edge → edge-tts`, `google → google`.
- O ARCHITECTURE.md §4.4 foi atualizado para este contrato.

## 5. DECISÃO — word timestamps no Google Cloud TTS ⭐

Esta é a decisão técnica central deste documento.

### 5.1 O problema

As legendas karaoke exigem `words[]` com `start`/`end` **exatos** (princípio "medir, não estimar", ARCHITECTURE.md §1). O Google Cloud TTS **não devolve timestamps por palavra nativamente**. Mas suporta **timepoints de SSML `<mark>`**: com input em SSML e `enable_time_pointing: ["SSML_MARK"]` (endpoint **v1beta1**), a resposta inclui `timepoints[]` com `mark_name` + `time_seconds` — o instante exato de cada marca no áudio.

### 5.2 A decisão

**Envolver cada palavra em `<mark name="w{i}"/>` e mapear os timepoints de volta às palavras.**

Algoritmo (a implementar no servidor Python, Fase 2):

1. Tokenizar o texto em palavras `w[0..n-1]` (preservar a ordem e o texto original para o `Word.word`).
2. Construir o SSML com a marca **antes** de cada palavra, escapando XML (`&`, `<`, `>`, `"`):
   ```xml
   <speak><mark name="w0"/>Acordas, <mark name="w1"/>pegas <mark name="w2"/>no ...</speak>
   ```
3. Pedir `POST https://texttospeech.googleapis.com/v1beta1/text:synthesize` com:
   - `input: { ssml }` (tem de ser SSML — timepoints **só** funcionam com input SSML),
   - `voice: { languageCode: "pt-PT", name: GOOGLE_TTS_VOICE }`,
   - `audioConfig: { audioEncoding: "MP3", speakingRate: rate }`,
   - `enableTimePointing: ["SSML_MARK"]`.
   - (Com a biblioteca Python: `from google.cloud import texttospeech_v1beta1 as tts` e `enable_time_pointing=[...SSML_MARK]`.)
4. Mapear: `words[i].start = timepoints["w{i}"].time_seconds`.
5. `words[i].end = words[i+1].start`; para a última palavra, `end = durationSec` do áudio gerado (medido do ficheiro, nunca estimado).
6. **Validar**: se o número de timepoints devolvidos ≠ número de palavras marcadas → descartar tudo e ir para o fallback (§5.3). Nunca misturar timepoints parciais com estimativas.

### 5.3 Fallback obrigatório: faster-whisper

Se os timepoints vierem incompletos ou ausentes (há registo histórico de marcas perdidas após pontuação em algumas vozes — a Fase 2 deve testar por voz), o servidor **corre o faster-whisper sobre o MP3 gerado** (já está no nosso stack, pacote `transcription`) para obter os timings por palavra. É mais lento que os marks, mas é medido e exato.

**Proibido**: sintetizar ou estimar timing uniforme (ex. dividir a duração pelo nº de palavras). Legendas karaoke com tempos inventados são piores que nenhumas — o princípio "medir, não estimar" é vinculativo.

### 5.4 Notas de implementação para a Fase 2 (servidor Python)

- Dependência: `google-cloud-texttospeech` (usar o módulo `v1beta1` — o `v1` estável **não** suporta `enable_time_pointing`).
- As marcas `<mark/>` não devem alterar a prosódia; se alguma voz as "lê" ou faz pausas estranhas, trocar de voz ou usar o fallback faster-whisper para essa voz.
- Cuidado com normalização de texto do Google (números, abreviaturas): o `Word.word` devolvido deve ser a palavra **original** do segmento (para as legendas baterem com a Spec), mesmo que o TTS a pronuncie de forma expandida.
- Medir `durationSec` do ficheiro de áudio real (ex. via `ffprobe`); o `time_seconds` do último mark não é o fim do áudio.
- Cache: o `audioPath` devolvido deve apontar para ficheiro persistido em `outputs/` (o pipeline gere o ciclo de vida).
- Testes Fase 2: para cada voz pt-PT candidata, sintetizar um parágrafo com pontuação variada e assert `len(timepoints) == len(palavras)`; registar que vozes passam no teste direto de marks e quais precisam sempre do fallback.

## 6. Resumo do que muda na Fase 2

- [ ] Servidor Python: implementar os três providers atrás do contrato do §4 (ficheiro/serviço único com switch por `provider`, ou adaptadores — decisão de implementação da Fase 2).
- [ ] Implementar o algoritmo de marks do §5.2 + fallback faster-whisper do §5.3 para o provider `google`.
- [ ] Validar vozes pt-PT reais (Kokoro, Edge-TTS e Google) e fixar os nomes exatos — os nomes neste documento marcados como "exemplos" têm de ser confirmados.
- [ ] Confirmar preços do tier grátis Google na página oficial antes de documentar números.
