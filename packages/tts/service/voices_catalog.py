# SPDX-License-Identifier: AGPL-3.0-only
"""Python view over the shared TTS voice catalog.

Single source of truth: ``packages/tts/voices.catalog.json`` — pure data
shared with the TypeScript pipeline (packages/pipeline/src/voiceCatalog.ts)
and the UI. The pipeline resolves (provider, voice) per job language and
always sends an explicit voice to /synthesize; this module gives providers
their language-agnostic defaults and lets them degrade gracefully when a
requested voice is unknown.

Code identifiers in English; user-facing strings in pt-PT.
"""

from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from pathlib import Path

log = logging.getLogger("shorts-forge.tts.catalog")


def catalog_path() -> Path:
    """Locate packages/tts/voices.catalog.json."""
    override = os.environ.get("SHORTS_FORGE_ROOT")
    if override:
        p = Path(override).expanduser().resolve() / "packages" / "tts" / "voices.catalog.json"
        if p.is_file():
            return p
    # packages/tts/service/voices_catalog.py -> packages/tts/
    return Path(__file__).resolve().parents[1] / "voices.catalog.json"


# Hardcoded last-resort defaults (used only when the catalog file itself is
# missing — the service must never fail to import).
_FALLBACK_PROVIDER_DEFAULTS = {
    "kokoro": "pf_dora",
    "edge-tts": "pt-PT-DuarteNeural",
    "google": "pt-PT-Neural2-A",
}


@lru_cache(maxsize=1)
def load_catalog() -> dict:
    """Load and minimally validate the catalog (cached)."""
    path = catalog_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        log.warning("catálogo de vozes em falta (%s): %s", path, exc)
        return {"version": 0, "providerDefaults": dict(_FALLBACK_PROVIDER_DEFAULTS), "languages": []}
    if not isinstance(data, dict) or not data.get("languages"):
        log.warning("catálogo de vozes inválido em %s", path)
        return {"version": 0, "providerDefaults": dict(_FALLBACK_PROVIDER_DEFAULTS), "languages": []}
    return data


def provider_default_voice(provider: str) -> str:
    """Default voice for a provider when no language context exists.

    Env vars (KOKORO_VOICE / EDGE_TTS_VOICE / GOOGLE_TTS_VOICE) take
    precedence — see config.py.
    """
    defaults = load_catalog().get("providerDefaults") or {}
    voice = defaults.get(provider)
    if isinstance(voice, str) and voice:
        return voice
    return _FALLBACK_PROVIDER_DEFAULTS.get(provider, "")


def supported_languages() -> list[str]:
    """Language tags in the catalog, in order."""
    return [l["tag"] for l in load_catalog().get("languages", []) if isinstance(l, dict) and l.get("tag")]


def language_default_voice(provider: str, language: str) -> str | None:
    """Catalog default voice for (provider, language), or None."""
    for lang in load_catalog().get("languages", []):
        if not isinstance(lang, dict) or lang.get("tag") != language:
            continue
        if lang.get("defaultProvider") == provider and lang.get("defaultVoice"):
            return lang["defaultVoice"]
        for v in lang.get("voices", []):
            if isinstance(v, dict) and v.get("provider") == provider and v.get("voice"):
                return v["voice"]
    return None


def locale_from_voice(voice: str, default: str = "pt-PT") -> str:
    """Infer the BCP-47 locale from a voice name like ``fr-FR-DeniseNeural``."""
    parts = (voice or "").split("-")
    if len(parts) >= 2 and len(parts[0]) == 2 and len(parts[1]) == 2:
        return f"{parts[0]}-{parts[1]}"
    return default
