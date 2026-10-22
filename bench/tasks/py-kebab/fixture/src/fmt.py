"""Text formatting helpers shared by the exporter."""

import re


def clean(text):
    """Lowercased, trimmed, inner whitespace collapsed to single spaces."""
    return re.sub(r"\s+", " ", str(text).lower().strip())
