# SPDX-License-Identifier: AGPL-3.0-only
"""Google provider logic tests with a mocked API (no credentials, no network).

Covers docs/tts-providers.md section 5 exactly:
- SSML is built with <mark name="w{i}"/> before each word (XML-escaped);
- timepoints map back to words; last word ends at measured duration;
- VALIDATION GATE: timepoint count != word count -> discard everything and
  use the faster-whisper fallback (mocked here);
- is_available() is False without credentials.
"""

import pytest

from providers.google_provider import GoogleProvider, build_marked_ssml


@pytest.fixture
def provider(monkeypatch):
    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "AIzaFakeKeyForTests")
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    return GoogleProvider()


def test_unavailable_without_credentials(monkeypatch):
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    monkeypatch.delenv("GOOGLE_TTS_API_KEY", raising=False)
    assert GoogleProvider().is_available() is False


def test_ssml_request_shape(monkeypatch, provider, tmp_path):
    captured = {}

    def fake_call(ssml, voice, speaking_rate, mode, language_code):
        captured.update(
            ssml=ssml, voice=voice, speaking_rate=speaking_rate,
            mode=mode, language_code=language_code,
        )
        # 3 words -> 3 timepoints, then a fake 2.0s mp3.
        mp3 = tmp_path / "out.mp3"
        mp3.write_bytes(b"fake")
        return mp3.read_bytes(), [("w0", 0.1), ("w1", 0.5), ("w2", 0.9)]

    monkeypatch.setattr(provider, "_call_api", fake_call)
    monkeypatch.setattr(
        "providers.google_provider.measure_duration_sec", lambda p: 2.0
    )

    def fake_persist(audio_bytes):
        p = tmp_path / "final.mp3"
        p.write_bytes(audio_bytes)
        return str(p)

    monkeypatch.setattr(provider, "_persist", fake_persist)
    result = provider.synthesize("um dois três", "", 1.2)

    assert captured["mode"] == "api_key"
    assert captured["language_code"] == "pt-PT"
    assert captured["speaking_rate"] == 1.2  # rate -> speakingRate
    assert captured["voice"] == "pt-PT-Neural2-A"  # default voice
    assert captured["ssml"] == build_marked_ssml(["um", "dois", "três"])
    assert '<mark name="w0"/>um' in captured["ssml"]
    assert result.words == [
        {"word": "um", "start": 0.1, "end": 0.5},
        {"word": "dois", "start": 0.5, "end": 0.9},
        {"word": "três", "start": 0.9, "end": 2.0},  # last word -> measured duration
    ]
    assert result.duration_sec == 2.0


def test_validation_gate_triggers_whisper_fallback(monkeypatch, provider, tmp_path):
    """Fewer timepoints than words -> discard, use whisper re-timing."""

    def fake_call(ssml, voice, speaking_rate, mode, language_code):
        # Simulate lost marks after punctuation: only 2 of 4 timepoints.
        return b"fake", [("w0", 0.1), ("w1", 0.5)]

    def fake_persist(audio_bytes):
        p = tmp_path / "final.mp3"
        p.write_bytes(audio_bytes)
        return str(p)

    fallback_words = [
        {"word": "um", "start": 0.1, "end": 0.4},
        {"word": "dois,", "start": 0.4, "end": 0.8},
        {"word": "três", "start": 0.8, "end": 1.2},
        {"word": "quatro.", "start": 1.2, "end": 1.9},
    ]
    monkeypatch.setattr(provider, "_call_api", fake_call)
    monkeypatch.setattr(provider, "_persist", fake_persist)
    monkeypatch.setattr(
        "providers.google_provider.measure_duration_sec", lambda p: 1.9
    )
    monkeypatch.setattr(
        "whisper_retime.retime_with_whisper",
        lambda audio_path, words: fallback_words,
    )
    result = provider.synthesize("um dois, três quatro.", "", 1.0)
    # Everything from the partial marks was discarded; whisper timings used.
    assert result.words == fallback_words
    assert result.duration_sec == 1.9


def test_rate_clamped_to_google_range(monkeypatch, provider, tmp_path):
    captured = {}

    def fake_call(ssml, voice, speaking_rate, mode, language_code):
        captured["speaking_rate"] = speaking_rate
        return b"fake", [("w0", 0.0)]

    def fake_persist(audio_bytes):
        p = tmp_path / "f.mp3"
        p.write_bytes(audio_bytes)
        return str(p)

    monkeypatch.setattr(provider, "_call_api", fake_call)
    monkeypatch.setattr(provider, "_persist", fake_persist)
    monkeypatch.setattr(
        "providers.google_provider.measure_duration_sec", lambda p: 0.5
    )
    provider.synthesize("olá", "", 99.0)
    assert captured["speaking_rate"] == 4.0  # Google max
