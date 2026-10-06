# SPDX-License-Identifier: AGPL-3.0-only
"""Provider interface for the shorts-forge TTS service.

Every provider turns text into an audio file plus measured word timestamps.
Providers that cannot serve (missing model, no network, no credentials)
raise :class:`ProviderUnavailable`; the service then falls back down the
canonical chain (kokoro → edge-tts → google) — never failing fatally while
a lower provider can serve.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


class ProviderUnavailable(Exception):
    """The provider cannot serve right now (not a synthesis bug)."""


class SynthesisError(Exception):
    """The provider failed to synthesize this request."""


@dataclass(frozen=True)
class ProviderResult:
    """Raw synthesis output from one provider."""

    audio_path: str
    """Absolute path of the persisted audio file (MP3)."""

    words: list[dict]
    """Measured word timestamps: [{word, start, end}] in seconds."""

    duration_sec: float
    """Measured duration of ``audio_path`` (ffprobe), never estimated."""

    voice: str
    """Effective voice used (may differ from the requested one)."""


class TtsProvider(ABC):
    """One TTS engine behind the /synthesize switch."""

    name: str = "base"

    @abstractmethod
    def is_available(self) -> bool:
        """True when this provider can serve requests right now."""

    @abstractmethod
    def default_voice(self) -> str:
        """Voice used when the request does not name a usable one."""

    @abstractmethod
    def synthesize(self, text: str, voice: str, rate: float) -> ProviderResult:
        """Synthesize ``text``; raise ProviderUnavailable/SynthesisError."""
