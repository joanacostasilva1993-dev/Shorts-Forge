# SPDX-License-Identifier: AGPL-3.0-only
"""Unit tests for voices_catalog.py — the Python view over the shared catalog.

No network, no models: only reads packages/tts/voices.catalog.json.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from voices_catalog import (  # noqa: E402
    catalog_path,
    language_default_voice,
    load_catalog,
    locale_from_voice,
    provider_default_voice,
    supported_languages,
)


def test_catalog_file_exists():
    assert catalog_path().is_file()


def test_catalog_has_four_languages_in_order():
    assert supported_languages() == ["pt-PT", "pt-BR", "en", "fr"]


def test_provider_defaults_match_documented_values():
    assert provider_default_voice("kokoro") == "pf_dora"
    assert provider_default_voice("edge-tts") == "pt-PT-DuarteNeural"
    assert provider_default_voice("google") == "pt-PT-Neural2-A"


def test_language_defaults():
    assert language_default_voice("edge-tts", "pt-PT") == "pt-PT-DuarteNeural"
    assert language_default_voice("kokoro", "pt-BR") == "pf_dora"
    assert language_default_voice("kokoro", "en") == "af_heart"
    assert language_default_voice("kokoro", "fr") == "ff_siwis"


def test_language_default_unknown_returns_none():
    assert language_default_voice("kokoro", "de") is None
    assert language_default_voice("watson", "fr") is None


def test_each_language_has_default_and_fallback_chain():
    catalog = load_catalog()
    assert catalog["version"] == 1
    for lang in catalog["languages"]:
        assert lang["defaultProvider"] and lang["defaultVoice"]
        chain = lang["fallbackChain"]
        assert len(chain) >= 2, f"{lang['tag']}: cadeia demasiado curta"
        assert chain[0] == {"provider": lang["defaultProvider"], "voice": lang["defaultVoice"]}
        # every chained voice must be listed in voices
        listed = {(v["provider"], v["voice"]) for v in lang["voices"]}
        for c in chain:
            assert (c["provider"], c["voice"]) in listed, f"{lang['tag']}: {c} fora de voices"


def test_locale_from_voice():
    assert locale_from_voice("fr-FR-DeniseNeural") == "fr-FR"
    assert locale_from_voice("pt-PT-DuarteNeural") == "pt-PT"
    assert locale_from_voice("pf_dora") == "pt-PT"
    assert locale_from_voice("") == "pt-PT"
