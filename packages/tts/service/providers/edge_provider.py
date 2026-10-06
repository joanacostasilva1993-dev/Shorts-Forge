# SPDX-License-Identifier: AGPL-3.0-only
"""Edge-TTS provider — free fallback, no key, needs network.

Word timestamps come from the service's own ``wordboundary`` events
(measured, in 100ns units) — no SSML marks needed. If boundary events are
missing for a voice, the faster-whisper re-timing fallback applies.
pt-PT voice names are verified at runtime via ``list_voices()``; the
candidates from docs/tts-providers.md are only defaults.
"""

from __future__ import annotations

import asyncio
import time
import uuid

import config
from providers.base import ProviderResult, ProviderUnavailable, SynthesisError, TtsProvider
from word_timing import measure_duration_sec, tokenize

_VOICES_CACHE: dict = {"at": 0.0, "voices": []}
_VOICES_TTL_SEC = 120.0


def _require_edge_tts():
    try:
        return __import__("edge_tts")
    except ImportError as exc:
        raise ProviderUnavailable(
            "Edge-TTS indisponível: pacote edge-tts não instalado."
        ) from exc


async def _fetch_voices_async() -> list[dict]:
    edge_tts = _require_edge_tts()
    return await edge_tts.list_voices()


def list_pt_voices() -> list[str]:
    """Exact pt-PT voice ShortNames, verified live (cached 120s)."""
    now = time.monotonic()
    if now - _VOICES_CACHE["at"] < _VOICES_TTL_SEC and _VOICES_CACHE["voices"]:
        return _VOICES_CACHE["voices"]
    try:
        voices = asyncio.run(_fetch_voices_async())
    except Exception as exc:  # noqa: BLE001 — network/DNS failures
        raise ProviderUnavailable(f"Edge-TTS indisponível (sem rede?): {exc}") from exc
    pt = sorted(
        v["ShortName"] for v in voices if v.get("Locale") == "pt-PT" and v.get("ShortName")
    )
    _VOICES_CACHE.update(at=now, voices=pt)
    return pt


def _rate_to_edge(rate: float) -> str:
    """1.0 -> '+0%', 1.2 -> '+20%', 0.8 -> '-20%' (edge-tts format)."""
    clamped = min(2.0, max(0.5, rate))
    return f"{(clamped - 1.0) * 100:+.0f}%"


class EdgeProvider(TtsProvider):
    name = "edge-tts"

    def default_voice(self) -> str:
        return config.EDGE_VOICE

    def is_available(self) -> bool:
        try:
            _require_edge_tts()
        except ProviderUnavailable:
            return False
        try:
            return bool(list_pt_voices())
        except ProviderUnavailable:
            return False

    def resolve_voice(self, requested: str) -> str:
        """Pick the effective voice: requested if real, else default, else first."""
        available = list_pt_voices()  # raises ProviderUnavailable when offline
        if requested.strip() in available:
            return requested.strip()
        if self.default_voice() in available:
            return self.default_voice()
        if available:
            return available[0]
        raise ProviderUnavailable("o Edge-TTS não listou vozes pt-PT.")

    def synthesize(self, text: str, voice: str, rate: float) -> ProviderResult:
        edge_tts = _require_edge_tts()
        if not tokenize(text):
            raise SynthesisError("texto vazio — nada para sintetizar.")
        eff_voice = self.resolve_voice(voice)
        audio_bytes, words = asyncio.run(
            self._stream(edge_tts, text, eff_voice, _rate_to_edge(rate))
        )
        if not audio_bytes:
            raise SynthesisError("o Edge-TTS não devolveu áudio.")
        out_path = config.OUTPUT_DIR / f"edge-tts-{uuid.uuid4().hex[:12]}.mp3"
        out_path.write_bytes(audio_bytes)
        duration_sec = measure_duration_sec(str(out_path))
        if not words:
            # No wordboundary events for this voice: measured whisper fallback.
            from whisper_retime import retime_with_whisper

            words = retime_with_whisper(str(out_path), tokenize(text))
        else:
            # Clamp the last word end to the measured duration.
            words[-1]["end"] = min(words[-1]["end"], duration_sec)
        return ProviderResult(
            audio_path=str(out_path), words=words,
            duration_sec=duration_sec, voice=eff_voice,
        )

    @staticmethod
    async def _stream(edge_tts, text: str, voice: str, rate: str):
        # boundary="WordBoundary" is what yields per-word events (the
        # default "SentenceBoundary" would only give sentence timings).
        # proxy comes from the environment so sandboxed/proxied networks work.
        import os

        proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
        communicate = edge_tts.Communicate(
            text, voice, rate=rate, boundary="WordBoundary", proxy=proxy
        )
        audio = bytearray()
        words: list[dict] = []
        async for chunk in communicate.stream():
            ctype = chunk.get("type")
            if ctype == "audio":
                audio.extend(chunk.get("data", b""))
            elif ctype == "wordboundary":
                # offset/duration are in 100ns units — measured by the service.
                start = chunk["offset"] / 1e7
                words.append(
                    {
                        "word": chunk["text"],
                        "start": start,
                        "end": start + chunk["duration"] / 1e7,
                    }
                )
        return bytes(audio), words


