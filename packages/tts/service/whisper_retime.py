# SPDX-License-Identifier: AGPL-3.0-only
"""faster-whisper re-timing fallback.

When a provider cannot supply measured word timestamps itself (Kokoro has
no native word timing in the installed version; Google marks may be lost
after punctuation on some voices), the generated audio file is transcribed
with ``word_timestamps=True`` and the measured timings are aligned back to
the ORIGINAL segment words (docs/tts-providers.md §5.4: ``Word.word`` must
be the original word so karaoke subtitles match the Spec).

This is slower than marks, but it is MEASURED — never estimated.
"""

from __future__ import annotations

import difflib
import re
from pathlib import Path

import config
from providers.base import ProviderUnavailable, SynthesisError

_WHISPER_MODEL = None


def _normalize(token: str) -> str:
    return re.sub(r"[^\w]", "", token.lower())


def align_words(
    expected: list[str], measured: list[dict]
) -> list[dict]:
    """Align measured (whisper) word timings onto the original words.

    ``expected``: original segment words. ``measured``: whisper output
    ``[{word, start, end}]``. Returns ``[{word=<original>, start, end}]``.

    Three passes, all grounded in measured audio time:
    1. difflib over normalized tokens — exact matches, plus single-word
       substitutions (e.g. ``"10"`` pronounced ``"dez"``: the measured span
       is real audio time for that word).
    2. Greedy concatenation for words the TTS/whisper split (``"Bem-vindo"``
       -> ``"bem"`` + ``"vindo"``): consecutive unconsumed tokens whose
       concatenated normalized form equals the target take their full span.
    3. Anything still unaligned (pure punctuation, truly unmeasurable)
       becomes an instant at the previous word's end — no timing is
       invented, and the original word is preserved for the subtitles.
    """
    if not expected:
        raise SynthesisError("sem palavras para alinhar.")
    if not measured:
        raise SynthesisError("o faster-whisper não devolveu palavras.")

    norm_exp = [_normalize(w) for w in expected]
    norm_meas = [_normalize(m["word"]) for m in measured]
    matcher = difflib.SequenceMatcher(None, norm_exp, norm_meas, autojunk=False)

    span_of: dict[int, tuple[float, float]] = {}
    owner: list[int | None] = [None] * len(measured)

    def claim(ei: int, mi: int) -> None:
        s, e = measured[mi]["start"], measured[mi]["end"]
        if ei in span_of:
            ps, pe = span_of[ei]
            span_of[ei] = (min(ps, s), max(pe, e))
        else:
            span_of[ei] = (s, e)
        owner[mi] = ei

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for ei, mi in zip(range(i1, i2), range(j1, j2)):
                claim(ei, mi)
        elif tag == "replace" and (i2 - i1) == 1 and (j2 - j1) == 1:
            claim(i1, j1)

    for ei in range(len(expected)):
        if ei in span_of:
            continue
        target = norm_exp[ei]
        if not target:
            continue
        cursor = 0
        for mi in range(len(measured)):
            if owner[mi] is not None and owner[mi] < ei:
                cursor = mi + 1
        acc, last = "", -1
        mi = cursor
        while mi < len(measured) and len(acc) < len(target):
            if owner[mi] is not None:
                break
            cand = acc + norm_meas[mi]
            if target[: len(cand)] != cand:
                break
            acc, last, mi = cand, mi, mi + 1
        if acc == target and last >= cursor:
            for mi2 in range(cursor, last + 1):
                claim(ei, mi2)

    out: list[dict] = []
    prev_end: float | None = None
    for ei, word in enumerate(expected):
        if ei in span_of:
            start, end = span_of[ei]
        elif prev_end is not None:
            start = end = prev_end
        else:
            start = end = measured[0]["start"]
        if end < start:
            end = start
        out.append({"word": word, "start": start, "end": end})
        prev_end = end
    return out


def _model_path() -> Path:
    """Local faster-whisper model dir (populated by npm run models:download).

    Layout shared with the transcription service: models/whisper/<name>/
    with model.bin directly inside (see scripts/models-download.mjs).
    """
    name = config.WHISPER_MODEL
    direct = config.WHISPER_MODEL_DIR / name
    if (direct / "model.bin").is_file():
        return direct
    # Fall back to faster-whisper's own cache/download behaviour.
    return Path(name)


def retime_with_whisper(audio_path: str, words: list[str]) -> list[dict]:
    """Transcribe ``audio_path`` and align timings onto ``words``."""
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise ProviderUnavailable(
            "fallback faster-whisper indisponível: pacote faster-whisper não instalado."
        ) from exc

    global _WHISPER_MODEL
    if _WHISPER_MODEL is None:
        try:
            _WHISPER_MODEL = WhisperModel(
                str(_model_path()), device="cpu", compute_type="int8"
            )
        except Exception as exc:  # noqa: BLE001
            raise ProviderUnavailable(
                f"fallback faster-whisper indisponível: não foi possível carregar "
                f"o modelo ({exc}). Corre `npm run models:download`."
            ) from exc

    try:
        segments, _info = _WHISPER_MODEL.transcribe(
            audio_path, language="pt", word_timestamps=True, vad_filter=True
        )
        measured = [
            {"word": w.word.strip(), "start": w.start, "end": w.end}
            for seg in segments
            for w in (seg.words or [])
            if w.word.strip()
        ]
    except Exception as exc:  # noqa: BLE001
        raise SynthesisError(f"o faster-whisper falhou no re-timing: {exc}") from exc

    aligned = align_words(words, measured)
    # docs/tts-providers.md §5.2 rule 5: the last word ends at the MEASURED
    # audio duration (trailing silence belongs to no word, but karaoke must
    # not end before the audio does).
    from word_timing import measure_duration_sec

    try:
        aligned[-1]["end"] = measure_duration_sec(audio_path)
    except RuntimeError:
        pass
    return aligned
