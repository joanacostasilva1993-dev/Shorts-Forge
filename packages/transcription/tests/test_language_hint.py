# SPDX-License-Identifier: AGPL-3.0-only
"""Unit tests for the /transcribe language hint (no model, no network).

Imports only the pure mapping function from the transcription server —
faster-whisper is never loaded here.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "service"))

from server import WHISPER_LANG_MAP, whisper_language_code  # noqa: E402


def test_catalog_languages_map_to_whisper_codes():
    assert whisper_language_code("pt-PT") == "pt"
    assert whisper_language_code("pt-BR") == "pt"
    assert whisper_language_code("en") == "en"
    assert whisper_language_code("fr") == "fr"


def test_bare_codes_pass_through():
    assert whisper_language_code("pt") == "pt"
    assert whisper_language_code("en") == "en"
    assert whisper_language_code("fr") == "fr"


def test_unknown_or_empty_falls_back_to_autodetect():
    assert whisper_language_code("de") is None
    assert whisper_language_code("") is None
    assert whisper_language_code(None) is None
    assert whisper_language_code("  ") is None


def test_map_covers_all_catalog_languages():
    for tag in ("pt-PT", "pt-BR", "en", "fr"):
        assert tag in WHISPER_LANG_MAP, f"{tag} em falta no WHISPER_LANG_MAP"
