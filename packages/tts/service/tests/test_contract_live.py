# SPDX-License-Identifier: AGPL-3.0-only
"""Contract tests for POST /synthesize — REAL providers (slow, needs models).

Run with:  TTS_LIVE=1 .venv/bin/python -m pytest tests/test_contract_live.py -q
Skipped by default (npm test runs only the fast unit tests).

These hit the real Kokoro (local) and Edge-TTS (network) providers through
the real FastAPI app, asserting the frozen contract from
docs/tts-providers.md section 4 and packages/pipeline/src/pythonBridge.ts.
"""

import os
import subprocess

import pytest

pytestmark = pytest.mark.live

TEXT = "Olá! Bem-vindo ao shorts-forge. Vamos transformar ideias em vídeos."


def _ffprobe_duration(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, timeout=30,
    )
    assert out.returncode == 0, "ffprobe falhou"
    return float(out.stdout.strip())


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    import app

    return TestClient(app.app)


def _edge_reachable() -> bool:
    """True when the sandbox/proxy lets us reach the Edge-TTS service.

    The sandbox egress proxy breaks the WebSocket upgrade, so live
    Edge-TTS synthesis is skipped here with a clear reason; it runs on an
    unproxied machine (e.g. Joana's PC).
    """
    try:
        from providers.edge_provider import EdgeProvider

        return EdgeProvider().is_available()
    except Exception:
        return False


EDGE_LIVE = pytest.mark.skipif(
    not _edge_reachable(), reason="Edge-TTS inalcançável desta sandbox (proxy)"
)


def _assert_tts_result(data: dict, provider: str):
    # Frozen contract: exactly these fields with these types.
    assert isinstance(data["audioPath"], str)
    assert isinstance(data["words"], list) and data["words"]
    assert isinstance(data["durationSec"], (int, float)) and data["durationSec"] > 0
    assert isinstance(data["voice"], str) and data["voice"]
    assert os.path.isfile(data["audioPath"]), "audioPath tem de existir"

    # durationSec is MEASURED: it must match ffprobe on the real file.
    measured = _ffprobe_duration(data["audioPath"])
    assert abs(data["durationSec"] - measured) < 0.15, (
        f"durationSec={data['durationSec']} mas ffprobe diz {measured}"
    )

    # Word timestamps: cover the audio, no gaps/overlaps beyond tolerance,
    # one word per token of the input text, sorted, start < end.
    from word_timing import check_word_coverage, tokenize

    words = data["words"]
    assert [w["word"] for w in words] == tokenize(TEXT), "Word.word = palavra original"
    assert check_word_coverage(words, data["durationSec"]) == []
    for w in words:
        assert isinstance(w["start"], (int, float))
        assert isinstance(w["end"], (int, float))
        assert 0 <= w["start"] < w["end"] <= data["durationSec"] + 0.35


def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert "kokoro" in body["modelsLoaded"]
    if _edge_reachable():
        assert "edge-tts" in body["modelsLoaded"]
    # No Google credentials in this environment -> not loaded, no fatal error.
    assert "google" not in body["modelsLoaded"]


def test_synthesize_kokoro(client):
    res = client.post(
        "/synthesize",
        json={"text": TEXT, "voice": "pf_dora", "rate": 1.0, "provider": "kokoro"},
    )
    assert res.status_code == 200, res.text
    assert res.headers["x-tts-provider"] == "kokoro"
    _assert_tts_result(res.json(), "kokoro")


def test_synthesize_kokoro_default_provider(client):
    # provider omitted -> defaults to kokoro.
    res = client.post("/synthesize", json={"text": TEXT, "voice": "", "rate": 1.0})
    assert res.status_code == 200, res.text
    assert res.headers["x-tts-provider"] == "kokoro"
    _assert_tts_result(res.json(), "kokoro")


@EDGE_LIVE
def test_synthesize_edge_tts(client):
    from providers.edge_provider import list_pt_voices

    voices = list_pt_voices()
    assert voices, "o Edge-TTS devia listar vozes pt-PT"
    res = client.post(
        "/synthesize",
        json={"text": TEXT, "voice": voices[0], "rate": 1.0, "provider": "edge-tts"},
    )
    assert res.status_code == 200, res.text
    assert res.headers["x-tts-provider"] == "edge-tts"
    _assert_tts_result(res.json(), "edge-tts")


def test_fallback_google_without_credentials(client, monkeypatch):
    # No Google credentials here: requesting google must NOT fail fatally —
    # it falls back down the chain to kokoro/edge-tts.
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    monkeypatch.delenv("GOOGLE_TTS_API_KEY", raising=False)
    res = client.post(
        "/synthesize",
        json={"text": TEXT, "voice": "", "rate": 1.0, "provider": "google"},
    )
    assert res.status_code == 200, res.text
    assert res.headers["x-tts-provider"] in ("kokoro", "edge-tts")
    _assert_tts_result(res.json(), "fallback")


def test_rate_changes_duration(client):
    slow = client.post(
        "/synthesize",
        json={"text": TEXT, "voice": "pf_dora", "rate": 0.8, "provider": "kokoro"},
    )
    fast = client.post(
        "/synthesize",
        json={"text": TEXT, "voice": "pf_dora", "rate": 1.2, "provider": "kokoro"},
    )
    assert slow.status_code == 200 and fast.status_code == 200
    assert slow.json()["durationSec"] > fast.json()["durationSec"], (
        "rate < 1 devia produzir áudio mais comprido"
    )


def test_empty_text_is_400_pt(client):
    res = client.post("/synthesize", json={"text": "   ", "provider": "kokoro"})
    assert res.status_code == 400
    err = res.json()["error"]
    assert err["code"] == "INVALID_REQUEST"
    assert isinstance(err["message"], str) and err["message"]


def test_unknown_provider_is_400_pt(client):
    res = client.post("/synthesize", json={"text": TEXT, "provider": "elevenlabs"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_REQUEST"
