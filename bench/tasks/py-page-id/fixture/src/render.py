"""Page rendering helpers."""

from src.textutil import normalize


def display_title(title):
    """Title as shown in the page header."""
    return normalize(title).title()
