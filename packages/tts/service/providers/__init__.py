# SPDX-License-Identifier: AGPL-3.0-only
"""TTS providers behind the /synthesize switch."""

from .base import ProviderResult, ProviderUnavailable, SynthesisError, TtsProvider
from .edge_provider import EdgeProvider
from .google_provider import GoogleProvider, resolve_auth
from .kokoro_provider import KokoroProvider

__all__ = [
    "ProviderResult",
    "ProviderUnavailable",
    "SynthesisError",
    "TtsProvider",
    "EdgeProvider",
    "GoogleProvider",
    "KokoroProvider",
    "resolve_auth",
]
