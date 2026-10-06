# SPDX-License-Identifier: AGPL-3.0-only
"""Word-level timing helpers shared by the TTS providers.

Two strategies exist, both MEASURED — invented/uniform timing is forbidden
(see docs/tts-providers.md):

1. **SSML marks** (Google Cloud TTS, v1beta1 ``enable_time_pointing``):
   every word is wrapped in ``<mark name="w{i}"/>``; the API returns one
   timepoint per mark. ``VALIDATION GATE``: if the number of timepoints
   returned differs from the number of marked words, everything is
   discarded and we fall back to strategy 2.
2. **faster-whisper re-timing** (``whisper_retime.py``): the generated audio
   file is transcribed with word timestamps — measured from the real audio.

Identifiers in English; user-facing strings stay in pt-PT.
"""

from __future__ import annotations

import re
import subprocess
import xml.sax.saxutils as saxutils
from dataclasses import dataclass

# Words are whitespace-separated tokens. Punctuation stays attached to the
# token (e.g. "olá," is one word) so Word.word matches the original text and
# karaoke subtitles line up with the Spec narration.
_WORD_RE = re.compile(r"\S+")


def tokenize(text: str) -> list[str]:
    """Split text into words, preserving order and original spelling."""
    return _WORD_RE.findall(text)


def escape_xml(text: str) -> str:
    """Escape a word for inclusion inside SSML."""
    return saxutils.escape(text, {'"': "&quot;"})


def build_marked_ssml(words: list[str]) -> str:
    """Build the SSML document with one ``<mark name="w{i}"/>`` per word.

    The mark sits BEFORE its word, so the returned timepoint is the word's
    start. Marks carry no audio and must not alter prosody.
    """
    parts = ["<speak>"]
    for i, word in enumerate(words):
        parts.append(f'<mark name="w{i}"/>{escape_xml(word)}')
        if i < len(words) - 1:
            parts.append(" ")
    parts.append("</speak>")
    return "".join(parts)


@dataclass(frozen=True)
class MarkResult:
    """Outcome of mapping SSML-mark timepoints back to words."""

    words: list[dict]
    """List of {word, start, end}; start/end in seconds."""

    @property
    def ok(self) -> bool:
        return bool(self.words)


def map_timepoints_to_words(
    words: list[str],
    timepoints: list[tuple[str, float]],
    duration_sec: float,
) -> MarkResult | None:
    """Map ``(mark_name, time_seconds)`` pairs to word timestamps.

    Returns ``None`` (validation gate FAILED) when the timepoint count does
    not equal the word count — the caller must then discard everything and
    use the faster-whisper fallback. Never mixes partial timepoints with
    estimates.

    Mapping rule (docs/tts-providers.md §5.2):
    ``words[i].start = timepoints["w{i}"].time_seconds``,
    ``words[i].end = words[i+1].start``; the last word ends at the measured
    ``duration_sec`` of the audio file.
    """
    if not words:
        return None
    by_name = {name: t for name, t in timepoints}
    # Validation gate: every marked word must have exactly one timepoint.
    if len(by_name) != len(words):
        return None
    try:
        starts = [by_name[f"w{i}"] for i in range(len(words))]
    except KeyError:
        return None
    # Timepoints must be non-decreasing; a scrambled response is unusable.
    if any(b < a for a, b in zip(starts, starts[1:])):
        return None
    out: list[dict] = []
    for i, word in enumerate(words):
        start = starts[i]
        end = starts[i + 1] if i + 1 < len(words) else duration_sec
        # A zero/negative-length word means the mark landed after the audio
        # end or the mapping is corrupt — fail the gate rather than emit it.
        if end <= start:
            return None
        out.append({"word": word, "start": start, "end": end})
    return MarkResult(words=out)


def check_word_coverage(
    words: list[dict],
    duration_sec: float,
    tolerance: float = 0.35,
) -> list[str]:
    """Sanity-check that word timestamps cover the audio plausibly.

    Returns a list of problem descriptions (empty = OK). Used by tests and
    by the service before returning a ``TtsResult``: timestamps must be
    sorted, non-overlapping, within the audio bounds, and the last word must
    end near the measured duration.
    """
    problems: list[str] = []
    if not words:
        return ["words vazio"]
    prev_end = 0.0
    for i, w in enumerate(words):
        if w["start"] < 0 or w["end"] > duration_sec + tolerance:
            problems.append(f"palavra {i} ({w['word']!r}) fora dos limites do áudio")
        if w["end"] < w["start"]:
            problems.append(f"palavra {i} ({w['word']!r}) com duração negativa")
        # Zero-duration words are allowed (an unmeasurable word becomes an
        # instant at the previous end); negative durations are not.
        if w["start"] < prev_end - tolerance:
            problems.append(f"palavra {i} ({w['word']!r}) sobrepõe-se à anterior")
        prev_end = w["end"]
    if abs(words[-1]["end"] - duration_sec) > tolerance:
        problems.append(
            f"última palavra termina em {words[-1]['end']:.2f}s "
            f"mas o áudio tem {duration_sec:.2f}s"
        )
    return problems


def measure_duration_sec(audio_path: str) -> float:
    """Measure the real duration of an audio file with ffprobe.

    Never estimated — used for ``TtsResult.durationSec`` and as the end
    of the last word (docs/tts-providers.md §5.2, rule 5).
    """
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", audio_path],
        capture_output=True, text=True, timeout=30,
    )
    if out.returncode != 0 or not out.stdout.strip():
        raise RuntimeError("não foi possível medir a duração do áudio (ffprobe).")
    return float(out.stdout.strip())
