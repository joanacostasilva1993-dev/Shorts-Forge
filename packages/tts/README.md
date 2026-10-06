# @shorts-forge/tts

> Serviço Python de texto-para-fala (TTS) com comutador de 3 providers.
> Corre em `http://127.0.0.1:8002` (configurável via `TTS_HOST`/`TTS_PORT`).

## Providers (por ordem de preferência)

| Provider | Omissão? | Custo | Chave | Vozes pt-PT | Word timestamps |
|---|---|---|---|---|---|
| `kokoro` | ✅ omissão | local, grátis | nenhuma | ⚠️ só pt-BR no Kokoro-82M (ver Amostras) | medidos via faster-whisper |
| `edge-tts` | fallback | grátis | nenhuma | sim (`pt-PT-*Neural`, nomes verificados em runtime) | nativos (`wordboundary`) |
| `google` | opcional | tier grátis, depois pago | `GOOGLE_TTS_API_KEY` ou `GOOGLE_APPLICATION_CREDENTIALS` | sim | SSML `<mark>` + `enable_time_pointing` (v1beta1), com fallback faster-whisper |

Se o provider pedido estiver indisponível (ex. `google` sem credenciais),
o serviço desce a cadeia automaticamente — nunca falha de forma fatal
enquanto um provider inferior conseguir servir.

Detalhes e decisões em [`docs/tts-providers.md`](../../docs/tts-providers.md).

## Contrato HTTP (congelado)

```
POST /synthesize  { text, voice, rate, provider } → TtsResult
GET  /health      → { ok: true, modelsLoaded: [...] }
```

Exemplo de resposta (`TtsResult`):

```jsonc
{
  "audioPath": "/…/outputs/tts/kokoro-a1b2c3d4e5f6.mp3",
  "words": [{ "word": "Olá!", "start": 0.08, "end": 0.42 }],
  "durationSec": 12.4,
  "voice": "pf_dora"
}
```

Erros (sempre em pt-PT): `{ "error": { "code": "…", "message": "…" } }`
(HTTP 400 para pedidos inválidos, 503 se nenhum provider conseguir servir).

**Regra dura:** `words[]` reflete tempos REAIS (medidos do áudio —
`wordboundary` do Edge, marks do Google, ou re-temporização faster-whisper).
Tempos inventados/uniformes são proibidos.

## Amostras de voz

Em [`samples/voices/`](samples/voices/) estão MP3s do mesmo parágrafo em
pt-PT com várias vozes + [`samples/VOICES.md`](samples/VOICES.md) (pt-PT)
com a descrição de cada amostra. A Joana ouve e aprova a voz omissa —
o TTS só está concluído com as amostras geradas.

> ⚠️ **Risco nº 1 do projeto:** o Kokoro-82M não traz vozes pt-PT nativas —
> as vozes portuguesas disponíveis são pt-BR (`pf_dora`, `pf_gloria`,
> `pf_linda`, `pm_alex`, `pm_marcos`, `pm_santa`; nomes verificados no
> pacote instalado). Para pt-PT europeu genuíno, usar `edge-tts`
> (`pt-PT-DuarteNeural`, `pt-PT-RaquelNeural`) ou `google`.

## Arranque

```bash
# 1. Modelos locais (Kokoro ~325MB; faster-whisper para o fallback de timing)
npm run models:download

# 2. Dependências Python (torch CPU primeiro — evita o bundle CUDA de ~550MB)
python3 -m venv packages/tts/service/.venv
packages/tts/service/.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
packages/tts/service/.venv/bin/pip install -r packages/tts/service/requirements.txt

# 3. Servir (o pipeline faz spawn disto automaticamente na Fase 2)
cd packages/tts/service && .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8002
```

Variáveis de ambiente (ver `.env.example` na raiz):

| Variável | Omissão | Notas |
|---|---|---|
| `KOKORO_VOICE` | `pf_dora` | voz Kokoro quando o pedido não nomeia uma válida |
| `EDGE_TTS_VOICE` | `pt-PT-DuarteNeural` | idem para Edge-TTS |
| `GOOGLE_TTS_VOICE` | `pt-PT-Neural2-A` | idem para Google (nome exato da voz) |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | caminho do JSON da service account (tem de existir); tem precedência |
| `GOOGLE_TTS_API_KEY` | — | chave de API simples (fallback) |
| `WHISPER_MODEL` | `small` | modelo faster-whisper do fallback de timing |
| `TTS_OUTPUT_DIR` | `<raiz>/outputs/tts` | onde ficam os MP3 (o pipeline gere o ciclo de vida) |
| `TTS_HOST` / `TTS_PORT` | `127.0.0.1` / `8002` | têm de bater com `pythonBridge.ts` |

## Testes

```bash
cd packages/tts/service
.venv/bin/python -m pytest tests/ -q -m "not live"   # unitários (rápidos)
TTS_LIVE=1 .venv/bin/python -m pytest tests/test_contract_live.py -q  # contrato real
```

Os testes live usam Kokoro + Edge-TTS a sério e verificam o contrato
completo (ficheiro existe, `durationSec` = ffprobe, palavras cobrem o áudio
sem buracos/sobreposições). O provider `google` não é testado live aqui —
precisa das credenciais da Joana.

## Estrutura (`service/`)

```
app.py                 FastAPI: POST /synthesize, GET /health, cadeia de fallback
config.py              raiz do repo, outputs/, modelos, env
word_timing.py         tokenize, SSML <mark>, mapeamento de timepoints, validações
whisper_retime.py      fallback faster-whisper (medido, nunca estimado)
providers/
  base.py              interface + ProviderResult / ProviderUnavailable
  kokoro_provider.py   KPipeline local (pt-BR), timing via whisper
  edge_provider.py     wordboundary nativos, vozes pt-PT verificadas em runtime
  google_provider.py   v1beta1 + SSML marks + validation gate (ver docs §5)
tests/                 unitários + contrato live (marcados)
```

O cliente TypeScript deste contrato vive em
`packages/pipeline/src/pythonBridge.ts` (`ServiceClients.synthesize`).
