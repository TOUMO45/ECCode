package textx

import "testing"

func TestHiddenTruncate(t *testing.T) {
	cases := []struct {
		s    string
		max  int
		want string
	}{
		{"hello", 10, "hello"},
		{"hello", 5, "hello"},
		{"hello world", 5, "hell…"},
		{"héllo wörld", 6, "héllo…"},
		{"abc", 1, "…"},
		{"abc", 0, ""},
		{"", 3, ""},
	}
	for _, c := range cases {
		if got := Truncate(c.s, c.max); got != c.want {
			t.Fatalf("Truncate(%q, %d) = %q, want %q", c.s, c.max, got, c.want)
		}
	}
	if RuneLen("ab") != 2 {
		t.Fatal("existing helper must survive")
	}
}
