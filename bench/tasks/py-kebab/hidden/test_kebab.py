import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from src.fmt import kebab, clean


def test_kebab_hidden():
    assert kebab("  Hello,  World! ") == "hello-world"
    assert kebab("Rust & Go: 2026") == "rust-go-2026"
    assert kebab("---") == ""
    assert callable(clean)
