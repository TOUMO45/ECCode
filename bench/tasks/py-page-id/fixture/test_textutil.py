from src.render import display_title
from src.textutil import normalize


def test_normalize():
    assert normalize("  A  B\tC ") == "a b c"


def test_display_title():
    assert display_title("  hello   world ") == "Hello World"
