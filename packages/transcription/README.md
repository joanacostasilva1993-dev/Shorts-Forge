# @shorts-forge/transcription

Micro-serviço Python de transcrição com
[faster-whisper](https://github.com/SYSTRAN/faster-whisper), a correr em
`http://127.0.0.1:8001` por omissão. Implementa o contrato HTTP consumido por
`ServiceClients.transcribe()` em `packages/pipeline/src/pythonBridge.ts`.

## Endpoints

### `POST /transcribe`

```jsonc
// pedido
{ "audioPath": "/caminho/para/audio.wav" }

// resposta 200 — TranscriptionResult
{
  "text": "Olá! Tudo bem?",
  "words": [
    { "word": "Olá!", "start": 0.0, "end": 0.46 },
    { "word": "Tudo", "start": 1.42, "end": 1.62 },
    { "word": "bem?", "start": 1.62, "end": 1.94 }
  ],
  "language": "pt"
}
```

A transcrição usa sempre `word_timestamps=True` — os tempos ao nível da
palavra são a base das legendas karaoke e da re-temporização da Fase B.
Inclui `vad_filter=True` para ignorar silêncios.

Erros (sempre JSON `{ "error": { "code", "message" } }`, mensagens em pt-PT):

| HTTP | `code` | Quando |
|---|---|---|
| 400 | `invalid_request` | corpo sem `audioPath` (ou vazio / JSON inválido) |
| 404 | `audio_not_found` | o ficheiro não existe |
| 422 | `decode_error` | o ficheiro não é áudio válido |
| 500 | `model_error` | o modelo faster-whisper falhou |
| 404 | `not_found` | rota desconhecida |
| 405 | `method_not_allowed` | método não suportado |

### `GET /health`

Responde `200` com `{ "ok": true, "modelsLoaded": ["small"] }`
(`modelsLoaded` vazio antes do modelo estar carregado).

## Instalação e arranque

```bash
# 1. pesos do modelo (WHISPER_MODEL, omissão "small") -> models/whisper/<nome>/
npm run models:download -- --only=whisper

# 2. ambiente Python (a partir da raiz do repo)
python3 -m venv packages/transcription/.venv
packages/transcription/.venv/bin/pip install -r packages/transcription/service/requirements.txt

# 3. arrancar (o pipeline faz spawn disto automaticamente na Fase 2)
packages/transcription/.venv/bin/python packages/transcription/service/server.py
```

O servidor só escuta em `127.0.0.1` (loopback). Sem dependências web: usa
apenas `http.server` da stdlib + faster-whisper.

### Variáveis de ambiente

| Variável | Omissão | Descrição |
|---|---|---|
| `TRANSCRIPTION_PORT` | `8001` | porta de escuta (deve bater com `DEFAULT_TRANSCRIPTION_URL` em `pythonBridge.ts`) |
| `WHISPER_MODEL` | `small` | nome do modelo faster-whisper (`tiny`, `base`, `small`, `medium`, …) ou caminho local |
| `WHISPER_MODEL_DIR` | _(auto)_ | diretório do modelo; por omissão usa `models/whisper/<WHISPER_MODEL>/` se existir `model.bin`, senão o nome é resolvido pelo faster-whisper |
| `WHISPER_DEVICE` | `cpu` | dispositivo do ctranslate2 |
| `WHISPER_COMPUTE_TYPE` | `int8` | `int8`, `int8_float32`, `float16`, `float32` |
| `WHISPER_EAGER_LOAD` | `0` | com `1`, carrega o modelo no arranque em vez de à primeira transcrição |

## Testes

```bash
# corre o serviço real + faster-whisper real sobre áudio português real
TRANSCRIPTION_TEST_PYTHON=/caminho/para/.venv/bin/python \
  node --test packages/transcription/tests/contract.test.mjs \
               packages/transcription/tests/wireup.test.mjs
```

- `contract.test.mjs` — contrato HTTP: `/health`, `/transcribe` sobre a
  amostra real (`tests/fixtures/amostra-pt.wav`, "Olá! Tudo bem?"),
  e todos os casos de erro.
- `wireup.test.mjs` — atravessa o `ServiceClients` real do
  `packages/pipeline` (o mesmo cliente que a Fase A usa), provando que o
  contrato bate certo nas duas pontas.

Sem faster-whisper instalado, os testes são saltados com aviso (não falham).

## Amostra de teste

`tests/fixtures/amostra-pt.wav` (2,38 s, 16 kHz mono): "olá" + pausa +
"tudo bem", montada com ffmpeg a partir de duas gravações do projeto
[Lingua Libre](https://lingualibre.org) no Wikimedia Commons, licença
**CC BY-SA 4.0**:

- `File:LL-Q5146 (por)-Santamarcanda-olá.wav` — "olá" (Santamarcanda, Porto)
- `File:LL-Q5146 (por)-Sillim-tudo bem.wav` — "tudo bem" (Sillim)

Atribuição aos autores conforme a licença indicada nas páginas dos ficheiros.

## Notas

- Cache de transcrições por hash SHA-256 do áudio: `packages/pipeline/src/cache.ts`
  (já implementado e testado; este serviço não precisa de cache própria).
- `service/requirements.txt` tem versões pinadas. **Não subir `av` para ≥19**:
  o faster-whisper 1.2.1 chama `av.open(..., metadata_errors="ignore")`,
  parâmetro removido no av 19 (ver comentário no ficheiro).
