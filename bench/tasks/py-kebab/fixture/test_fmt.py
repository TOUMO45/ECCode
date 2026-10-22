from src.fmt import clean


def test_clean():
    assert clean("  A  B\tC ") == "a b c"
