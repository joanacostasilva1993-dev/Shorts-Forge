# SPDX-License-Identifier: AGPL-3.0-only
"""Fallback-chain ordering tests (needs fastapi, no models/network)."""

import app


def test_chain_requested_first_then_canonical_order():
    # The requested provider is always tried first; the rest follow the
    # canonical preference order (kokoro -> edge-tts -> google). "Falling
    # back down the chain" means towards the more fundamental providers:
    # google without credentials falls back to kokoro (local default),
    # then edge-tts — never failing fatally while one can serve.
    assert [p.name for p in app.resolve_chain("kokoro")] == ["kokoro", "edge-tts", "google"]
    assert [p.name for p in app.resolve_chain("edge-tts")] == ["edge-tts", "kokoro", "google"]
    assert [p.name for p in app.resolve_chain("google")] == ["google", "kokoro", "edge-tts"]
