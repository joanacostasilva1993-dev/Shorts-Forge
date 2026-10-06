# SPDX-License-Identifier: AGPL-3.0-only
"""Unit tests for provider selection/auth logic (no network, no models)."""

import pytest

from providers.base import ProviderUnavailable
from providers.google_provider import (
    _language_code_from_voice,
    _looks_like_placeholder,
    resolve_auth,
)
from whisper_retime import align_words


# -- Google auth precedence -------------------------------------------


def _set_env(monkeypatch, adc=None, key=None):
    for var in ("GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_TTS_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    if adc is not None:
        monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", adc)
    if key is not None:
        monkeypatch.setenv("GOOGLE_TTS_API_KEY", key)


def test_auth_prefers_existing_service_account_file(monkeypatch, tmp_path):
    cred = tmp_path / "sa.json"
    cred.write_text("{}")
    _set_env(monkeypatch, adc=str(cred), key="AIzaRealKey123")
    mode, _ = resolve_auth()
    assert mode == "service_account"


def test_auth_falls_through_when_adc_file_missing(monkeypatch):
    _set_env(monkeypatch, adc="/nao/existe/sa.json", key="AIzaRealKey123")
    mode, _ = resolve_auth()
    assert mode == "api_key"


def test_auth_api_key_only(monkeypatch):
    _set_env(monkeypatch, key="AIzaRealKey123")
    mode, cred = resolve_auth()
    assert mode == "api_key"
    assert cred == "AIzaRealKey123"


def test_auth_unavailable_without_credentials(monkeypatch):
    _set_env(monkeypatch)
    with pytest.raises(ProviderUnavailable):
        resolve_auth()


def test_auth_ignores_placeholder_values(monkeypatch):
    # .env.example placeholders must NOT count as credentials.
    _set_env(
        monkeypatch,
        adc="/caminho/para/service-account.json",
        key="<redacted>",
    )
    with pytest.raises(ProviderUnavailable):
        resolve_auth()


def test_language_code_from_voice():
    assert _language_code_from_voice("pt-PT-Neural2-A") == "pt-PT"
    assert _language_code_from_voice("pt-PT-DuarteNeural") == "pt-PT"
    assert _language_code_from_voice("en-US-Neural2-A") == "en-US"
    assert _language_code_from_voice("weird") == "pt-PT"


# -- whisper word alignment --------------------------------------------


def test_align_words_exact_match():
    expected = ["Olá,", "mundo!"]
    measured = [
        {"word": "Olá,", "start": 0.1, "end": 0.4},
        {"word": "mundo!", "start": 0.5, "end": 0.9},
    ]
    out = align_words(expected, measured)
    assert out[0] == {"word": "Olá,", "start": 0.1, "end": 0.4}
    assert out[1] == {"word": "mundo!", "start": 0.5, "end": 0.9}


def test_align_words_tts_normalization_mismatch():
    # TTS pronounced "10" as "dez": a single-word substitution takes the
    # measured span — real audio time, never invented.
    expected = ["são", "10", "horas"]
    measured = [
        {"word": "são", "start": 0.0, "end": 0.3},
        {"word": "dez", "start": 0.3, "end": 0.6},
        {"word": "horas", "start": 0.6, "end": 1.0},
    ]
    out = align_words(expected, measured)
    assert [w["word"] for w in out] == expected
    assert out[1] == {"word": "10", "start": 0.3, "end": 0.6}


def test_align_words_split_word_greedy():
    # whisper split "Bem-vindo" into "bem" + "-vindo": the concatenation
    # equals the target, so the word takes the full measured span.
    expected = ["Olá!", "Bem-vindo", "ao"]
    measured = [
        {"word": "Olá,", "start": 0.0, "end": 0.38},
        {"word": "bem", "start": 0.56, "end": 0.68},
        {"word": "-vindo", "start": 0.68, "end": 0.94},
        {"word": "ao", "start": 0.94, "end": 1.02},
    ]
    out = align_words(expected, measured)
    assert out[0] == {"word": "Olá!", "start": 0.0, "end": 0.38}
    assert out[1] == {"word": "Bem-vindo", "start": 0.56, "end": 0.94}
    assert out[2] == {"word": "ao", "start": 0.94, "end": 1.02}


def test_align_words_pure_punctuation_is_instant():
    # "—" was never spoken: it becomes an instant at the previous end.
    # No timing invented; the word is preserved for the subtitles.
    expected = ["olá", "—", "mundo"]
    measured = [
        {"word": "olá", "start": 0.0, "end": 0.4},
        {"word": "mundo", "start": 0.5, "end": 0.9},
    ]
    out = align_words(expected, measured)
    assert out[1] == {"word": "—", "start": 0.4, "end": 0.4}


def test_align_words_empty_measured_raises():
    with pytest.raises(Exception):
        align_words(["olá"], [])


def test_placeholder_detection():
    assert _looks_like_placeholder("<redacted>")
    assert _looks_like_placeholder("cola-aqui-o-nome-da-voz")
    assert not _looks_like_placeholder("AIzaSyD-real-key")
