# SPDX-License-Identifier: AGPL-3.0-only
"""Shared configuration for the shorts-forge TTS service.

Resolves paths relative to the repository root and reads runtime
configuration from the environment (see .env.example at the repo root).
"""

from __future__ import annotations

import os
from pathlib import Path


def find_repo_root(start: Path | None = None) -> Path:
    """Walk up from ``start`` until the shorts-forge repo root is found.

    The root is the first ancestor containing ``packages/tts/service`` or a
    ``package.json`` whose ``"name"`` is ``shorts-forge``.
    """
    override = os.environ.get("SHORTS_FORGE_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    here = (start or Path(__file__)).resolve()
    for parent in (here, *here.parents):
        if (parent / "packages" / "tts" / "service").is_dir():
            return parent
        pkg = parent / "package.json"
        if pkg.is_file():
            try:
                if '"name": "shorts-forge"' in pkg.read_text(encoding="utf-8"):
                    return parent
            except OSError:
                pass
    # Fallback: two levels above this file (packages/tts/service -> root).
    return Path(__file__).resolve().parents[2]


REPO_ROOT = find_repo_root()


def _sanitize_no_proxy() -> None:
    """Remove bracketed IPv6 literals (e.g. ``[::1]``) from NO_PROXY/no_proxy.

    httpx 0.28.x (used by huggingface_hub) crashes parsing them
    (``Invalid port: ':1]'``); other clients ignore or mishandle them too.
    The remaining entries keep working — this only drops the malformed ones.
    """
    for var in ("NO_PROXY", "no_proxy"):
        val = os.environ.get(var)
        if val and ("[" in val or "]" in val):
            os.environ[var] = ",".join(
                e for e in val.split(",") if "[" not in e and "]" not in e
            )


_sanitize_no_proxy()

# Where finished audio files are persisted. The pipeline owns their lifecycle.
OUTPUT_DIR = Path(os.environ.get("TTS_OUTPUT_DIR", REPO_ROOT / "outputs" / "tts"))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Local model caches (populated by `npm run models:download`).
MODELS_DIR = REPO_ROOT / "models"
KOKORO_MODEL_DIR = Path(os.environ.get("KOKORO_MODEL_DIR", MODELS_DIR / "kokoro"))
WHISPER_MODEL_DIR = Path(os.environ.get("WHISPER_MODEL_DIR", MODELS_DIR / "whisper"))

# Provider defaults (overridable per request via the `voice` field).
KOKORO_VOICE = os.environ.get("KOKORO_VOICE", "pf_dora")
EDGE_VOICE = os.environ.get("EDGE_TTS_VOICE", "pt-PT-DuarteNeural")
GOOGLE_TTS_VOICE = os.environ.get("GOOGLE_TTS_VOICE", "pt-PT-Neural2-A")

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")

# Canonical provider preference order. A failed requested provider falls back
# to the remaining providers in this order — the pipeline never fails fatally
# while a lower (more fundamental) provider can serve.
PROVIDER_ORDER = ("kokoro", "edge-tts", "google")

# Bind address/port — must match DEFAULT_TTS_URL in
# packages/pipeline/src/pythonBridge.ts (http://127.0.0.1:8002).
HOST = os.environ.get("TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("TTS_PORT", "8002"))
