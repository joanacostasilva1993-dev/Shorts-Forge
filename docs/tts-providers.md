# Providers de TTS — shorts-forge

> Estado: Fase 3. Contrato do cliente TypeScript finalizado
> (`packages/pipeline/src/pythonBridge.ts`); servidores Python dos três
> providers implementados na Fase 2. **Catálogo de vozes por idioma**
> (fonte única de verdade): `packages/tts/voices.catalog.json` —
> ver [docs/i18n.md](./i18n.md) para omissões, cadeias de fallback e a
> decisão da voz francesa.
> Identificadores de código em inglês; este documento em pt-PT.

## 1. Visão geral

O shorts-forge suporta três providers de texto-para-fala, selecionáveis na UI:

| Provider | Omissão? | Custo | Chave | Vozes pt-PT | Word timestamps |
|---|---|---|---|---|---|
| **Kokoro** | ✅ omissão | local, grátis | nenhuma | **não tem** (só pt-BR: `pf_dora`, `pm_alex`, `pm_santa` — confirmado em runtime na Fase 2) | via faster-whisper (confirmado na Fase 2) |
| **Edge-TTS** | fallback | grátis | nenhuma | sim (`pt-PT-DuarteNeural`, `pt-PT-RaquelNeural` — confirmados via `list_voices()`) | nativos (`wordboundary`) |
| **Google Cloud TTS** | opcional | tier grátis generoso, depois pago por carácter | `GOOGLE_TTS_API_KEY` **ou** `GOOGLE_APPLICATION_CREDENTIALS` | sim (nomes a confirmar com credenciais) | via SSML `<mark>` + `enable_time_pointing` (ver §4) |

Regras que não mudam:

- **Kokoro continua a omissão**: fluxo completo funciona a 100% sem chaves e sem internet (política free-only, ARCHITECTURE.md §9).
- Google Cloud TTS é **first-class mas opcional**: aparece na UI como terceira opção, nunca no caminho crítico. Sem credenciais configuradas, o provider fica indisponível e o pipeline usa Kokoro/Edge-TTS.
- Os três providers devolvem o mesmo `TtsResult` canónico (`audioPath`, `words[]`, `durationSec`, `voice`) — ver contrato final no §3.

## 2. Comparação detalhada

### Kokoro (omissão — local, grátis, sem chave)

- Corre em Python no PC, sem rede e sem conta.
- **Não tem vozes pt-PT** (confirmado em runtime na Fase 2: as únicas
  portuguesas são `pf_dora`, `pm_alex`, `pm_santa` — todas pt-BR). Para
  sotaque europeu genuíno, a omissão pt-PT é `edge-tts`
  (`pt-PT-DuarteNeural`/`pt-PT-RaquelNeural`). Tem voz francesa
  (`ff_siwis` — única, mas **rejeitada** como omissão fr pela Joana em
  2026-10-06: robótica, sotaque misto; fica só como último fallback
  local) e inglesas (`af_heart` = omissão en, `af_bella`,
  `am_adam`, …) — ver o catálogo e [docs/i18n.md](./i18n.md).
- Word timestamps via re-temporização faster-whisper sobre o áudio gerado
  (confirmado na Fase 2; o `KPipeline` não devolve timestamps nativos).
- Variável: `KOKORO_VOICE` (nome da voz no catálogo Kokoro; omissão do
  catálogo quando vazia).

### Edge-TTS (fallback grátis)

- Serviço gratuito da Microsoft, sem chave, via rede.
- Vozes pt-PT confirmadas via `list_voices()` em runtime:
  `pt-PT-DuarteNeural`, `pt-PT-RaquelNeural` (ver
  `packages/tts/samples/VOICES.md`).
- **Fase 3 (i18n):** o provider resolve vozes por locale inferido do nome
  da voz (`fr-FR-*` → lista `fr-FR`), em vez de filtrar só pt-PT. Vozes
  `fr-FR-*`, `en-US-*` e `pt-BR-*` no catálogo estão **por verificar** no PC
  da Joana (a sandbox bloqueia o WebSocket do Edge-TTS) — ver
  [docs/i18n.md](./i18n.md) §4 e `packages/tts/service/verify_voices.py`.
- Word timestamps nativos via eventos `wordboundary`; fallback
  faster-whisper quando a voz não os emite.

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

- [x] Servidor Python: implementar os três providers atrás do contrato do §4 (ficheiro/serviço único com switch por `provider`, ou adaptadores — decisão de implementação da Fase 2).
- [x] Implementar o algoritmo de marks do §5.2 + fallback faster-whisper do §5.3 para o provider `google`.
- [x] Validar vozes pt-PT reais (Kokoro, Edge-TTS e Google) e fixar os nomes exatos — **resultado: Kokoro não tem pt-PT** (só pt-BR); Edge-TTS `pt-PT-DuarteNeural`/`pt-PT-RaquelNeural` confirmados via `list_voices()`; Google por confirmar com credenciais.
- [ ] Confirmar preços do tier grátis Google na página oficial antes de documentar números.

## 7. Fase 3 (i18n) — vozes por idioma

- Catálogo de vozes por idioma em `packages/tts/voices.catalog.json`
  (fonte única de verdade para pipeline, serviço Python e UI).
- Resolução de voz language-aware na Fase B: escolha explícita da UI >
  env > omissão do catálogo para o idioma do job
  (`packages/pipeline/src/voiceCatalog.ts::resolveTtsForJob`).
- Omissões: pt-PT → `edge-tts/pt-PT-DuarteNeural`; pt-BR →
  `kokoro/pf_dora`; en → `kokoro/af_heart`; fr →
  `edge-tts/fr-FR-DeniseNeural` (decisão da Joana de ouvido, 2026-10-06 —
  a `ff_siwis` do Kokoro foi rejeitada por ser robótica e misturar
  sotaques; fica só como último fallback local).
- Detalhes, racional e checklist de verificação manual: [docs/i18n.md](./i18n.md).

## 8. Princípio: naturalidade da voz primeiro (Joana, 2026-10-06) ⭐

**O áudio gerado NÃO pode soar robótico.** A naturalidade da voz é o
critério nº 1 na escolha de vozes e providers — acima da preferência por
local/offline:

- Vozes neurais (**Edge-TTS Neural**, **Google WaveNet/Neural2**) têm
  prioridade mesmo exigindo rede (são grátis e sem chave no caso do
  Edge-TTS; o Google tem tier grátis generoso — o **free-only**
  mantém-se: nada pago no caminho crítico).
- O modo 100% local (Kokoro) passa a ser **alternativa de robustez** —
  continua no fim das cadeias de fallback para o pipeline funcionar
  offline — mas já não é a omissão quando há conflito com a naturalidade.

**Aplicações diretas já feitas:**

- **Francês:** a `ff_siwis` (Kokoro) foi rejeitada pela Joana de ouvido
  (robótica, mistura sotaque pt com francês) → omissão fr =
  `edge-tts`/`fr-FR-DeniseNeural`, que exige rede. Exceção deliberada e
  consciente ao princípio anterior da Fase 3 ("omissão não exige rede").
- **pt-PT:** cadeia reordenada para `DuarteNeural → RaquelNeural →
  google/pt-PT-Neural2-A → kokoro/pf_dora` — uma voz pt-BR nunca precede
  uma neural pt-PT nativa sob este princípio; a `pf_dora` fica como
  último recurso offline.
- **Inglês (pendente de ouvido):** o default continua `kokoro/af_heart`
  (a Joana nunca o rejeitou e o Kokoro tem boa qualidade), mas sob este
  princípio é candidato a teste A/B por ouvido (`af_heart` vs
  `en-US-AriaNeural`, Edge-TTS). **Não mudar o default sem ela ouvir** —
  ver checklist em [docs/i18n.md](./i18n.md) §4.
