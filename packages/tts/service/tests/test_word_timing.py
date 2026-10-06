# SPDX-License-Identifier: AGPL-3.0-only
"""Unit tests for word-timing logic (no network, no models)."""

from word_timing import (
    build_marked_ssml,
    check_word_coverage,
    escape_xml,
    map_timepoints_to_words,
    tokenize,
)


def test_tokenize_preserves_punctuation_and_order():
    text = "Olá! Bem-vindo ao shorts-forge — vamos?"
    words = tokenize(text)
    assert words == ["Olá!", "Bem-vindo", "ao", "shorts-forge", "—", "vamos?"]
    # Joining with single spaces reconstructs a normalized form of the text.
    assert " ".join(words) == " ".join(text.split())


def test_tokenize_empty():
    assert tokenize("") == []
    assert tokenize("   \n\t ") == []


def test_escape_xml():
    assert escape_xml('a&b<"c">') == "a&amp;b&lt;&quot;c&quot;&gt;"


def test_build_marked_ssml_marks_before_words():
    ssml = build_marked_ssml(["Olá,", "mundo!"])
    assert ssml == '<speak><mark name="w0"/>Olá, <mark name="w1"/>mundo!</speak>'


def test_build_marked_ssml_escapes_words():
    ssml = build_marked_ssml(["a&b", "<tag>"])
    assert "<mark name=\"w0\"/>a&amp;b" in ssml
    assert "<mark name=\"w1\"/>&lt;tag&gt;" in ssml


def test_map_timepoints_happy_path():
    words = ["Acordas,", "pegas", "no"]
    tps = [("w0", 0.10), ("w1", 0.55), ("w2", 0.90)]
    res = map_timepoints_to_words(words, tps, duration_sec=1.40)
    assert res is not None and res.ok
    assert res.words[0] == {"word": "Acordas,", "start": 0.10, "end": 0.55}
    assert res.words[1] == {"word": "pegas", "start": 0.55, "end": 0.90}
    # Last word ends at the MEASURED audio duration, never estimated.
    assert res.words[2] == {"word": "no", "start": 0.90, "end": 1.40}


def test_map_timepoints_single_word():
    res = map_timepoints_to_words(["Olá!"], [("w0", 0.05)], duration_sec=0.8)
    assert res is not None
    assert res.words == [{"word": "Olá!", "start": 0.05, "end": 0.8}]


def test_validation_gate_count_mismatch():
    # Fewer timepoints than words -> discard everything (None), never mix.
    words = ["um", "dois", "três"]
    assert map_timepoints_to_words(words, [("w0", 0.1), ("w1", 0.5)], 1.0) is None
    # More timepoints than words -> also fails the gate.
    assert (
        map_timepoints_to_words(
            words, [("w0", 0.1), ("w1", 0.5), ("w2", 0.9), ("w3", 1.2)], 1.5
        )
        is None
    )


def test_validation_gate_missing_mark_name():
    words = ["um", "dois"]
    assert map_timepoints_to_words(words, [("w0", 0.1), ("w9", 0.5)], 1.0) is None


def test_validation_gate_non_monotonic():
    words = ["um", "dois"]
    assert map_timepoints_to_words(words, [("w0", 0.6), ("w1", 0.5)], 1.0) is None


def test_validation_gate_zero_length_word():
    words = ["um", "dois"]
    # Last word would end at duration < its start -> corrupt, fail the gate.
    assert map_timepoints_to_words(words, [("w0", 0.1), ("w1", 1.5)], 1.0) is None


def test_validation_gate_empty_words():
    assert map_timepoints_to_words([], [], 1.0) is None


def test_check_word_coverage_ok():
    words = [
        {"word": "a", "start": 0.0, "end": 0.3},
        {"word": "b", "start": 0.3, "end": 0.7},
        {"word": "c", "start": 0.7, "end": 1.0},
    ]
    assert check_word_coverage(words, 1.0) == []


def test_check_word_coverage_detects_overlap():
    words = [
        {"word": "a", "start": 0.0, "end": 0.5},
        {"word": "b", "start": 0.1, "end": 0.7},
    ]
    problems = check_word_coverage(words, 1.0)
    assert any("sobrep" in p for p in problems)


def test_check_word_coverage_detects_last_word_far_from_duration():
    words = [{"word": "a", "start": 0.0, "end": 0.5}]
    problems = check_word_coverage(words, 5.0)
    assert any("última palavra" in p for p in problems)


def test_check_word_coverage_detects_out_of_bounds():
    words = [{"word": "a", "start": 0.0, "end": 12.0}]
    problems = check_word_coverage(words, 2.0)
    assert any("fora dos limites" in p for p in problems)


def test_check_word_coverage_empty():
    assert check_word_coverage([], 1.0) != []
