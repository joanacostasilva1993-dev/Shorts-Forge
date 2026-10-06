# SPDX-License-Identifier: AGPL-3.0-only
"""shorts-forge TTS service — HTTP local em 127.0.0.1:8002.

Contrato (congelado, ver docs/tts-providers.md §4 e
packages/pipeline/src/pythonBridge.ts)::

    POST /synthesize { text, voice, rate, provider } -> TtsResult
    GET  /health -> { ok: true, modelsLoaded: [...] }

Provider order: kokoro (default, local, no key) -> edge-tts (fallback,
no key) -> google (optional, needs credentials). A requested provider that
cannot serve falls back down the chain automatically; errors are reported
in pt-PT as { error: { code, message } }.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

import config
from providers import (
    EdgeProvider,
    GoogleProvider,
    KokoroProvider,
    ProviderUnavailable,
    SynthesisError,
    TtsProvider,
)
from word_timing import check_word_coverage

log = logging.getLogger("shorts-forge.tts")

app = FastAPI(title="shorts-forge TTS", version="0.1.0")

_PROVIDERS: dict[str, TtsProvider] = {
    "kokoro": KokoroProvider(),
    "edge-tts": EdgeProvider(),
    "google": GoogleProvider(),
}


def _err(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse(
        status_code=status, content={"error": {"code": code, "message": message}}
    )


def resolve_chain(requested: str) -> list[TtsProvider]:
    """Requested provider first, then the rest in canonical order."""
    names = [requested] + [n for n in config.PROVIDER_ORDER if n != requested]
    return [_PROVIDERS[n] for n in names]


@app.get("/health")
def health() -> dict[str, Any]:
    loaded = [name for name, p in _PROVIDERS.items() if p.is_available()]
    return {"ok": True, "modelsLoaded": loaded}


@app.post("/synthesize")
async def synthesize(request: Request) -> Any:
    try:
        body = await request.json()
    except Exception:
        return _err("INVALID_REQUEST", "o corpo do pedido tem de ser JSON.", 400)
    if not isinstance(body, dict):
        return _err("INVALID_REQUEST", "o corpo do pedido tem de ser um objeto JSON.", 400)

    text = body.get("text", "")
    voice = body.get("voice", "") or ""
    rate = body.get("rate", 1.0)
    provider = body.get("provider", "kokoro") or "kokoro"

    if not isinstance(text, str) or not text.strip():
        return _err("INVALID_REQUEST", "o campo «text» é obrigatório e não pode estar vazio.", 400)
    if provider not in _PROVIDERS:
        return _err(
            "INVALID_REQUEST",
            f"provider desconhecido «{provider}» — usa kokoro, edge-tts ou google.",
            400,
        )
    try:
        rate = float(rate)
    except (TypeError, ValueError):
        return _err("INVALID_REQUEST", "o campo «rate» tem de ser um número.", 400)
    if not (0.25 <= rate <= 4.0):
        return _err("INVALID_REQUEST", "o campo «rate» tem de estar entre 0.25 e 4.0.", 400)

    failures: list[str] = []
    for prov in resolve_chain(provider):
        try:
            # Providers are blocking (torch, network); run them in a worker
            # thread so the event loop stays responsive. This also keeps
            # asyncio.run() usable inside providers (no running loop here).
            result = await run_in_threadpool(prov.synthesize, text, voice, rate)
        except ProviderUnavailable as exc:
            failures.append(f"{prov.name}: indisponível ({exc})")
            continue
        except SynthesisError as exc:
            failures.append(f"{prov.name}: falhou ({exc})")
            continue
        except Exception as exc:  # noqa: BLE001 — never leak a traceback shape
            log.exception("provider %s rebentou", prov.name)
            failures.append(f"{prov.name}: erro interno ({exc})")
            continue

        problems = check_word_coverage(result.words, result.duration_sec)
        if problems:
            failures.append(f"{prov.name}: timestamps inválidos ({problems[0]})")
            continue

        response = JSONResponse(
            content={
                "audioPath": result.audio_path,
                "words": result.words,
                "durationSec": result.duration_sec,
                "voice": result.voice,
            }
        )
        response.headers["x-tts-provider"] = prov.name
        return response

    detail = "; ".join(failures) if failures else "sem detalhe"
    return _err(
        "ALL_PROVIDERS_FAILED",
        f"nenhum provider de TTS conseguiu sintetizar: {detail}",
        503,
    )


def main() -> None:
    import uvicorn

    uvicorn.run(
        "app:app",
        host=config.HOST,
        port=config.PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()
