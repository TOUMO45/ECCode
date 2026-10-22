import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from src.report import sum_column

CSV = "amount,label\n10.5,a\n# note\n2,b\noops,c\n,d\n3.5,e\n"


def test_sum_column_hidden():
    assert sum_column(CSV, "amount") == 16.0
    assert sum_column(CSV, "missing") == 0
    assert sum_column("", "amount") == 0
