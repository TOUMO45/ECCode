from src.report import parse_rows


def test_parse_rows():
    rows = parse_rows("a,b\n1,2\n# comment\n3,\n")
    assert rows == [{"a": "1", "b": "2"}, {"a": "3"}]
