#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Verifica as vozes do catálogo contra os providers reais.

Uso (no PC da Joana, com rede):
    cd packages/tts/service
    .venv/bin/python verify_voices.py

Compara cada voz de packages/tts/voices.catalog.json com:
  - Kokoro: vozes instaladas em models/kokoro/voices/*.pt (local, sem rede)
  - Edge-TTS: list_voices() ao vivo (precisa de rede; falha nesta sandbox
    por causa do proxy MITM — é esperado)

Saída: tabela por idioma com o estado de cada voz (OK / EM FALTA /
NAMED-NOT-FOUND) para a Joana decidir as omissões de ouvido.
"""

from __future__ import annotations

import asyncio
import sys

sys.path.insert(0, ".")

from voices_catalog import load_catalog  # noqa: E402


def kokoro_voices() -> set[str]:
    try:
        from providers.kokoro_provider import available_voices

        return set(available_voices())
    except Exception as exc:  # noqa: BLE001
        print(f"[kokoro] indisponível: {exc}")
        return set()


def edge_voices() -> dict[str, set[str]]:
    """locale -> set of ShortNames (empty dict when unreachable)."""
    try:
        import edge_tts

        voices = asyncio.run(edge_tts.list_voices())
    except Exception as exc:  # noqa: BLE001
        print(f"[edge-tts] inalcançável (rede?): {exc}")
        return {}
    out: dict[str, set[str]] = {}
    for v in voices:
        locale = v.get("Locale") or ""
        name = v.get("ShortName") or ""
        if locale and name:
            out.setdefault(locale, set()).add(name)
    return out


def main() -> int:
    catalog = load_catalog()
    kokoro = kokoro_voices()
    edge = edge_voices()

    print(f"catálogo v{catalog.get('version')} — {len(catalog.get('languages', []))} idiomas")
    print(f"kokoro local: {len(kokoro)} vozes | edge-tts ao vivo: {'sim' if edge else 'NÃO (sem rede?)'}")
    print()

    failures = 0
    for lang in catalog.get("languages", []):
        tag = lang["tag"]
        print(f"== {tag} — {lang['label']} ==")
        default = f"{lang['defaultProvider']}:{lang['defaultVoice']}"
        print(f"   omissão: {default}")
        for v in lang["voices"]:
            provider, voice = v["provider"], v["voice"]
            if provider == "kokoro":
                ok = voice in kokoro
                status = "OK (local)" if ok else "EM FALTA (models/kokoro/voices)"
            elif provider == "edge-tts":
                locale = "-".join(voice.split("-")[:2])
                names = edge.get(locale, set())
                if not edge:
                    status = "POR VERIFICAR (edge-tts inalcançável aqui)"
                    ok = True  # não é falha — é desta sandbox
                elif voice in names:
                    status = "OK (verificado ao vivo)"
                    ok = True
                else:
                    status = f"NOME NÃO ENCONTRADO no locale {locale}"
                    ok = False
            else:  # google — precisa de credenciais; não verificável aqui
                status = "POR VERIFICAR (requer credenciais Google)"
                ok = True
            mark = "✓" if ok else "✗"
            verified = "verificada" if v.get("verified") else "NÃO verificada no catálogo"
            print(f"   [{mark}] {provider:9} {voice:28} {status} [{verified}]")
            if not ok:
                failures += 1
        print()

    if failures:
        print(f"{failures} voz(es) do catálogo NÃO encontradas nos providers — rever nomes.")
        return 1
    print("Todas as vozes verificáveis estão OK.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
