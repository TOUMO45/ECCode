package mathx

import "testing"

func TestMinMax(t *testing.T) {
	if Min(1, 2) != 1 || Max(1, 2) != 2 {
		t.Fatal("min/max broken")
	}
}
