# SPDX-License-Identifier: AGPL-3.0-only
"""Kokoro provider — default, local, no key, no network needed.

The installed kokoro release does NOT expose native word timestamps
(``KPipeline`` yields per-chunk audio only), so word timing is measured
with the faster-whisper re-timing of the generated audio — the same
measured fallback docs/tts-providers.md section 5.3 mandates for Google.

Portuguese voices in the stock Kokoro-82M release are Brazilian
(``pf_*``/``pm_*``) — verified at runtime; there is NO native pt-PT voice
(see samples/VOICES.md and the task report: project risk #1).
"""

from __future__ import annotations

import logging
import subprocess
import uuid

import config
from providers.base import ProviderResult, ProviderUnavailable, SynthesisError, TtsProvider
from word_timing import measure_duration_sec, tokenize

log = logging.getLogger("shorts-forge.tts.kokoro")

_SAMPLE_RATE = 24000
_LANG_CODE = "p"  # KPipeline language code for Portuguese

_PIPELINE = None


def _require_kokoro():
    try:
        from kokoro import KPipeline

        return KPipeline
    except ImportError as exc:
        raise ProviderUnavailable(
            "Kokoro indisponível: pacote kokoro não instalado."
        ) from exc


def _model_files() -> tuple:
    d = config.KOKORO_MODEL_DIR
    return d / "kokoro-v1_0.pth", d / "config.json"


def model_file_present() -> bool:
    pth, cfg = _model_files()
    return pth.is_file() and cfg.is_file()


def available_voices() -> list[str]:
    """Voice ids in models/kokoro/voices/*.pt — verified, not guessed."""
    voices_dir = config.KOKORO_MODEL_DIR / "voices"
    if not voices_dir.is_dir():
        return []
    return sorted(p.stem for p in voices_dir.glob("*.pt"))


def voice_path(voice: str) -> str:
    return str(config.KOKORO_MODEL_DIR / "voices" / f"{voice}.pt")


def _load_pipeline():
    global _PIPELINE
    if _PIPELINE is not None:
        return _PIPELINE
    from kokoro import KModel, KPipeline

    _require_kokoro()
    pth, cfg = _model_files()
    if not model_file_present():
        raise ProviderUnavailable(
            "modelo Kokoro em falta em models/kokoro — corre `npm run models:download`."
        )
    # Local files: no HF download at runtime (works offline, uses models/kokoro).
    model = KModel(repo_id="hexgrad/Kokoro-82M", config=str(cfg), model=str(pth))
    _PIPELINE = KPipeline(lang_code=_LANG_CODE, repo_id="hexgrad/Kokoro-82M", model=model)
    return _PIPELINE


class KokoroProvider(TtsProvider):
    name = "kokoro"

    def default_voice(self) -> str:
        return config.KOKORO_VOICE

    def is_available(self) -> bool:
        try:
            _require_kokoro()
        except ProviderUnavailable:
            return False
        return model_file_present()

    def resolve_voice(self, requested: str) -> str:
        voices = available_voices()
        if requested.strip() in voices:
            return requested.strip()
        if self.default_voice() in voices:
            return self.default_voice()
        # Prefer a Portuguese voice; otherwise any voice (never fail here —
        # an unknown voice name must not break synthesis, it only changes
        # the reported voice).
        for v in voices:
            if v.startswith(("pf_", "pm_")):
                return v
        if voices:
            return voices[0]
        raise ProviderUnavailable("o Kokoro não tem vozes disponíveis.")

    def synthesize(self, text: str, voice: str, rate: float) -> ProviderResult:
        if not tokenize(text):
            raise SynthesisError("texto vazio — nada para sintetizar.")
        pipeline = _load_pipeline()
        eff_voice = self.resolve_voice(voice)
        speed = min(2.0, max(0.5, rate))
        try:
            import torch

            chunks = []
            # Voice as a local .pt path: no HF download at runtime.
            generator = pipeline(text, voice=voice_path(eff_voice), speed=speed)
            for _gs, _ps, audio in generator:
                chunks.append(audio)
            if not chunks:
                raise SynthesisError("o Kokoro não gerou áudio.")
            waveform = torch.cat(chunks, dim=0).cpu().numpy()
        except ProviderUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001
            raise SynthesisError(f"o Kokoro falhou a sintetizar: {exc}") from exc

        wav_path = config.OUTPUT_DIR / f"kokoro-{uuid.uuid4().hex[:12]}.wav"
        mp3_path = wav_path.with_suffix(".mp3")
        try:
            import soundfile as sf

            sf.write(str(wav_path), waveform, _SAMPLE_RATE)
        except ImportError as exc:
            raise ProviderUnavailable(
                "Kokoro indisponível: pacote soundfile não instalado."
            ) from exc
        try:
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-i", str(wav_path),
                 "-codec:a", "libmp3lame", "-b:a", "128k", str(mp3_path)],
                check=True, timeout=120,
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise SynthesisError(f"falha a codificar o MP3: {exc}") from exc
        finally:
            wav_path.unlink(missing_ok=True)

        duration_sec = measure_duration_sec(str(mp3_path))
        from whisper_retime import retime_with_whisper

        words = retime_with_whisper(str(mp3_path), tokenize(text))
        return ProviderResult(
            audio_path=str(mp3_path), words=words,
            duration_sec=duration_sec, voice=eff_voice,
        )


