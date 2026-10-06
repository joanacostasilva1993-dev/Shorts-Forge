# SPDX-License-Identifier: AGPL-3.0-only
"""Generate the voice samples for Joana's approval (packages/tts/samples/voices/).

Synthesizes the SAME pt-PT paragraph with each candidate voice and writes
<provider>-<voicename>.mp3 files. Run from the service dir with the venv:

    cd packages/tts/service && .venv/bin/python generate_samples.py

Edge-TTS samples are skipped automatically when the network/WS path is
unavailable (they can be generated on an unproxied machine).
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from providers.base import ProviderUnavailable  # noqa: E402
from providers.edge_provider import EdgeProvider, list_pt_voices  # noqa: E402
from providers.kokoro_provider import KokoroProvider  # noqa: E402

PARAGRAPH = (
    "Olá! Bem-vindo ao shorts-forge. "
    "Hoje vamos transformar uma simples ideia num vídeo pronto a publicar: "
    "com narração clara, legendas sincronizadas e o ritmo certo. "
    "Preparado? Vamos a isto!"
)

SAMPLES_DIR = Path(__file__).resolve().parents[1] / "samples" / "voices"


def main() -> None:
    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    plan: list[tuple[str, object, str]] = []
    kokoro = KokoroProvider()
    for voice in ("pf_dora", "pm_alex", "pm_santa"):
        plan.append((f"kokoro-{voice}.mp3", kokoro, voice))
    try:
        for voice in list_pt_voices():
            plan.append((f"edge-tts-{voice}.mp3", EdgeProvider(), voice))
    except ProviderUnavailable as exc:
        print(f"[samples] Edge-TTS indisponível ({exc}) — amostras edge adiadas.")

    for filename, provider, voice in plan:  # type: ignore[union-attr]
        out = SAMPLES_DIR / filename
        if out.exists():
            print(f"[samples] {filename} já existe — a saltar.")
            continue
        print(f"[samples] a gerar {filename} …")
        try:
            result = provider.synthesize(PARAGRAPH, voice, 1.0)  # type: ignore[union-attr]
        except (ProviderUnavailable, Exception) as exc:
            print(f"[samples] FALHOU {filename}: {exc}")
            continue
        shutil.copyfile(result.audio_path, out)
        print(
            f"[samples] OK {filename} "
            f"({result.duration_sec:.1f}s, {len(result.words)} palavras, voz={result.voice})"
        )


if __name__ == "__main__":
    main()
