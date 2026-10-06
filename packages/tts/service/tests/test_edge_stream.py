# SPDX-License-Identifier: AGPL-3.0-only
"""Edge-TTS stream parsing test with a mocked Communicate (no network).

Verifies OUR code: wordboundary chunks (offset/duration in 100ns units)
are converted to {word, start, end} in seconds, in order.
"""

import asyncio

from providers.edge_provider import EdgeProvider


class _FakeCommunicate:
    def __init__(self, *args, **kwargs):
        self.kwargs = kwargs

    async def stream(self):
        # Canned chunks mimicking edge-tts wire format.
        yield {"type": "wordboundary", "text": "Olá!", "offset": 800000, "duration": 3600000}
        yield {"type": "audio", "data": b"\xff\xf3" + b"\x00" * 100}
        yield {"type": "wordboundary", "text": "mundo", "offset": 5000000, "duration": 4000000}
        yield {"type": "audio", "data": b"\x00" * 100}


class _FakeEdgeTts:
    Communicate = _FakeCommunicate


def test_stream_parses_wordboundaries():
    audio, words = asyncio.run(
        EdgeProvider._stream(_FakeEdgeTts(), "Olá! mundo", "pt-PT-DuarteNeural", "+0%")
    )
    assert len(audio) == 202
    assert words == [
        {"word": "Olá!", "start": 0.08, "end": 0.44},
        {"word": "mundo", "start": 0.5, "end": 0.9},
    ]


def test_communicate_uses_word_boundary_mode():
    captured = {}

    class _SpyCommunicate(_FakeCommunicate):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            captured.update(kwargs)

    class _SpyModule:
        Communicate = _SpyCommunicate

    asyncio.run(EdgeProvider._stream(_SpyModule(), "texto", "voz", "+0%"))
    # The default "SentenceBoundary" would only give sentence timings —
    # we must request per-word events explicitly.
    assert captured.get("boundary") == "WordBoundary"
