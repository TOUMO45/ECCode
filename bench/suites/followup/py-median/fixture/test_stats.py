from src.stats import mean, numbers


def test_numbers():
    assert numbers([1, None, "x", 2.5, True]) == [1, 2.5]


def test_mean():
    assert mean([2, None, 4]) == 3
    assert mean([None]) is None
