"""Text helpers shared by the renderer and the search indexer."""

import re


def normalize(text):
    """Lowercased, trimmed, inner whitespace collapsed to single spaces."""
    return re.sub(r"\s+", " ", str(text).lower().strip())
