import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from src.stats import median, numbers


def test_odd():
    assert median([5, 1, 3]) == 3


def test_even_is_mean_of_middle():
    assert median([4, 1, 3, 2]) == 2.5


def test_junk_ignored():
    assert median([None, 7, "8", 1, True, 3.0]) == 3.0


def test_none_left():
    assert median([None, "x"]) is None
    assert median([]) is None


def test_existing_helper_survives():
    assert numbers([1, None]) == [1]
