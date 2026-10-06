#!/usr/bin/env python3
"""AGPL-3.0-only

Transcription microservice for shorts-forge.

Exposes the frozen HTTP contract consumed by
`packages/pipeline/src/pythonBridge.ts` (`ServiceClients.transcribe`):

    POST /transcribe  { "audioPath": string, "language"?: string } -> TranscriptionResult
    GET  /health                                                  -> { "ok": true, "modelsLoaded": [...] }

`language` is an OPTIONAL BCP-47-ish hint (e.g. "pt-PT", "fr") coming from
the job language. It is mapped to a faster-whisper language code and passed
as the `language` param of `model.transcribe()` — it biases detection, it
never invents content. Unknown/absent values keep auto-detect.

Runs faster-whisper locally with ``word_timestamps=True``. No mocks: every
endpoint performs real work. The server binds to 127.0.0.1 only.

Configuration (environment variables):
    TRANSCRIPTION_PORT   Port to listen on.              Default: 8001
    WHISPER_MODEL        Model name (e.g. small) or local path.
                                                    Default: small
    WHISPER_MODEL_DIR    Explicit model directory. Overrides the
                         auto-resolution below.
    WHISPER_DEVICE       Device for ctranslate2.         Default: cpu
    WHISPER_COMPUTE_TYPE Compute type (int8, int8_float32,
                         float16, float32).             Default: int8
    WHISPER_EAGER_LOAD   Load the model at startup when "1".
                                                    Default: lazy

Model resolution: if ``WHISPER_MODEL`` names a directory under
``<repo>/models/whisper/<name>`` containing ``model.bin`` (populated by
``npm run models:download``), that directory is used; otherwise the value
is passed to faster-whisper, which resolves it as a built-in size or a
Hugging Face repo id (downloading to the HF cache on first use).
"""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

LOG = logging.getLogger("transcription")


def _sanitize_proxy_env() -> None:
    """Drop bracketed IPv6 entries from NO_PROXY/no_proxy.

    httpx 0.28.x (pulled in by huggingface_hub) crashes while building its
    proxy map when NO_PROXY contains bracketed IPv6 literals such as
    ``[::1]`` (``httpx.InvalidURL: Invalid port: ':1]'``). Those entries are
    irrelevant for downloads from huggingface.co, so they are removed from
    this process's environment before any HTTP client is constructed.
    """
    for var in ("NO_PROXY", "no_proxy"):
        val = os.environ.get(var)
        if not val:
            continue
        kept = [e for e in val.split(",") if "[" not in e and "]" not in e]
        if len(kept) != len(val.split(",")):
            LOG.info("a remover entradas IPv6 de %s (workaround httpx 0.28)", var)
            os.environ[var] = ",".join(kept)


_sanitize_proxy_env()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PORT = int(os.environ.get("TRANSCRIPTION_PORT", "8001"))
MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
EAGER_LOAD = os.environ.get("WHISPER_EAGER_LOAD", "0") == "1"

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MODEL_DIR = REPO_ROOT / "models" / "whisper" / MODEL_NAME

MAX_BODY_BYTES = 1 * 1024 * 1024  # 1 MiB — /transcribe only takes a path


def resolve_model_dir() -> str:
    """Return the model identifier/path to hand to faster-whisper."""
    explicit = os.environ.get("WHISPER_MODEL_DIR")
    if explicit:
        return explicit
    if DEFAULT_MODEL_DIR.is_dir() and (DEFAULT_MODEL_DIR / "model.bin").is_file():
        LOG.info("a usar modelo local em %s", DEFAULT_MODEL_DIR)
        return str(DEFAULT_MODEL_DIR)
    return MODEL_NAME


MODEL_REF = resolve_model_dir()

# ---------------------------------------------------------------------------
# Model lifecycle (lazy, thread-safe)
# ---------------------------------------------------------------------------

_model: Any = None
_model_lock = threading.Lock()


def get_model() -> Any:
    """Load the faster-whisper model once; raise RuntimeError on failure."""
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel

            LOG.info(
                "a carregar modelo faster-whisper %r (device=%s, compute_type=%s)…",
                MODEL_REF,
                DEVICE,
                COMPUTE_TYPE,
            )
            try:
                _model = WhisperModel(
                    MODEL_REF, device=DEVICE, compute_type=COMPUTE_TYPE
                )
            except Exception as exc:  # noqa: BLE001 — surfaced as JSON error
                raise RuntimeError(
                    f"falha ao carregar o modelo de transcrição ({MODEL_REF}): {exc}"
                ) from exc
            LOG.info("modelo carregado")
        return _model


def models_loaded() -> list[str]:
    return [MODEL_NAME] if _model is not None else []


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------

# Errors faster-whisper / PyAV raise when the input cannot be decoded.
# Imported lazily so the module stays importable without the deps installed
# (useful for --help style introspection); resolved at call time.


def _is_decode_error(exc: BaseException) -> bool:
    name = type(exc).__name__
    module = type(exc).__module__ or ""
    text = f"{module}.{name}: {exc}".lower()
    decode_markers = (
        "invaliddataerror",
        "decod",
        "averror",
        "ffmpeg",
        "could not open",
        "no such file",
        "moov atom not found",
        "ebml",
    )
    return any(m in text for m in decode_markers)


# BCP-47-ish tags (the job language) -> faster-whisper language codes.
# Only the four catalog languages map; anything else keeps auto-detect.
WHISPER_LANG_MAP = {
    "pt-PT": "pt",
    "pt-BR": "pt",
    "pt": "pt",
    "en": "en",
    "en-US": "en",
    "en-GB": "en",
    "fr": "fr",
    "fr-FR": "fr",
}


def whisper_language_code(tag: str | None) -> str | None:
    """Map a job language tag to a faster-whisper code, or None (auto-detect)."""
    if not tag:
        return None
    return WHISPER_LANG_MAP.get(tag.strip())


def transcribe_file(audio_path: str, language: str | None = None) -> dict[str, Any]:
    """Transcribe an audio file. Returns a TranscriptionResult dict.

    Args:
        audio_path: absolute path of the audio file.
        language: optional BCP-47-ish hint (e.g. "pt-PT"); mapped to a
            faster-whisper code and passed as the `language` transcribe
            param. Unknown values fall back to auto-detect.

    Raises:
        FileNotFoundError: audio file does not exist / is not a file.
        ValueError:        the file cannot be decoded as audio.
        RuntimeError:      the model failed to load or crashed.
    """
    path = Path(audio_path).expanduser()
    if not path.is_file():
        raise FileNotFoundError(f"ficheiro de áudio não encontrado: {audio_path}")

    model = get_model()
    whisper_lang = whisper_language_code(language) if language else None

    try:
        transcribe_kwargs: dict[str, Any] = dict(
            word_timestamps=True,
            vad_filter=True,  # skip silence; keeps word times aligned to speech
        )
        if whisper_lang:
            transcribe_kwargs["language"] = whisper_lang
        segments_iter, info = model.transcribe(str(path), **transcribe_kwargs)
        words: list[dict[str, Any]] = []
        texts: list[str] = []
        for segment in segments_iter:
            texts.append(segment.text)
            for w in segment.words or []:
                token = (w.word or "").strip()
                if not token:
                    continue
                words.append(
                    {
                        "word": token,
                        "start": round(float(w.start), 3),
                        "end": round(float(w.end), 3),
                    }
                )
        text = "".join(texts).strip()
        language = getattr(info, "language", "") or ""
    except FileNotFoundError:
        raise
    except Exception as exc:  # noqa: BLE001 — classified below
        if _is_decode_error(exc):
            raise ValueError(
                f"não foi possível descodificar o áudio ({path.name}): {exc}"
            ) from exc
        raise RuntimeError(f"falha na transcrição: {exc}") from exc

    return {"text": text, "words": words, "language": language}


# ---------------------------------------------------------------------------
# HTTP layer (stdlib only — no web framework dependency)
# ---------------------------------------------------------------------------


def _error(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message}}


class Handler(BaseHTTPRequestHandler):
    server_version = "shorts-forge-transcription/1.0"

    # -- helpers ----------------------------------------------------------
    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> Any:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return None
        if length > MAX_BODY_BYTES:
            raise ValueError("corpo do pedido demasiado grande")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"corpo JSON inválido: {exc}") from exc

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: N802
        LOG.info("%s — %s", self.address_string(), fmt % args)

    # -- routes -----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/health":
            self._send_json(200, {"ok": True, "modelsLoaded": models_loaded()})
        else:
            self._send_json(404, _error("not_found", "rota desconhecida"))

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/transcribe":
            self._send_json(404, _error("not_found", "rota desconhecida"))
            return
        try:
            body = self._read_json_body()
        except ValueError as exc:
            self._send_json(400, _error("invalid_request", str(exc)))
            return

        if not isinstance(body, dict) or not isinstance(body.get("audioPath"), str):
            self._send_json(
                400,
                _error(
                    "invalid_request",
                    "pedido inválido: o campo 'audioPath' é obrigatório "
                    "e tem de ser uma string",
                ),
            )
            return
        audio_path = body["audioPath"].strip()
        if not audio_path:
            self._send_json(
                400,
                _error(
                    "invalid_request",
                    "pedido inválido: 'audioPath' não pode ser vazio",
                ),
            )
            return

        # Optional language hint (BCP-47-ish, e.g. "pt-PT"); unknown values
        # fall back to auto-detect inside transcribe_file.
        language_hint = body.get("language")
        if language_hint is not None and not isinstance(language_hint, str):
            self._send_json(
                400,
                _error(
                    "invalid_request",
                    "pedido inválido: 'language' tem de ser uma string",
                ),
            )
            return

        try:
            result = transcribe_file(audio_path, language=language_hint or None)
        except FileNotFoundError as exc:
            self._send_json(404, _error("audio_not_found", str(exc)))
        except ValueError as exc:
            self._send_json(422, _error("decode_error", str(exc)))
        except RuntimeError as exc:
            self._send_json(500, _error("model_error", str(exc)))
        except Exception as exc:  # noqa: BLE001 — last-resort envelope
            LOG.exception("erro inesperado ao transcrever")
            self._send_json(
                500, _error("internal_error", f"erro interno do serviço: {exc}")
            )
        else:
            self._send_json(200, result)

    # Explicitly reject anything else with the JSON envelope.
    def do_PUT(self) -> None:  # noqa: N802
        self._send_json(405, _error("method_not_allowed", "método não suportado"))

    do_DELETE = do_PUT
    do_PATCH = do_PUT


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True

    def _stop(signum: int, _frame: Any) -> None:
        LOG.info("sinal %s recebido — a encerrar", signum)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    LOG.info(
        "serviço de transcrição a ouvir em http://127.0.0.1:%d (modelo=%s)",
        PORT,
        MODEL_REF,
    )
    if EAGER_LOAD:
        try:
            get_model()
        except RuntimeError as exc:
            LOG.error("%s", exc)
            return 1
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    LOG.info("encerrado")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
