"""CSV report helpers. parse_rows is the one parser everything builds on."""


def parse_rows(text):
    """Parse CSV text into dicts keyed by the header row.

    Blank lines and lines starting with '#' are skipped. Values are strings;
    a short row leaves the missing columns out of its dict.
    """
    lines = [l for l in text.splitlines() if l.strip() and not l.lstrip().startswith("#")]
    if not lines:
        return []
    header = [h.strip() for h in lines[0].split(",")]
    rows = []
    for line in lines[1:]:
        values = [v.strip() for v in line.split(",")]
        rows.append({h: v for h, v in zip(header, values) if v != ""})
    return rows
