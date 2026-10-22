package mathx

import "testing"

func TestHiddenClamp(t *testing.T) {
	cases := [][4]int{{5, 1, 10, 5}, {-3, 0, 10, 0}, {42, 0, 10, 10}, {5, 10, 1, 5}, {0, 10, 1, 1}}
	for _, c := range cases {
		if got := Clamp(c[0], c[1], c[2]); got != c[3] {
			t.Fatalf("Clamp(%d,%d,%d) = %d, want %d", c[0], c[1], c[2], got, c[3])
		}
	}
}
