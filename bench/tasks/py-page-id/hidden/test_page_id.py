import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from src.textutil import page_id


def test_basic():
    assert page_id("  Hello,  World! ") == "hello-world"


def test_symbol_runs_become_one_hyphen():
    assert page_id("Q4 -- Report (final)") == "q4-report-final"


def test_no_edge_hyphens():
    assert page_id("!!!Already-Kebab!!!") == "already-kebab"


def test_numbers_kept():
    assert page_id("Top 10 lists, 2026") == "top-10-lists-2026"
