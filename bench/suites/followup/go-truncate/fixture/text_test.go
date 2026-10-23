package textx

import "testing"

func TestRuneLenInitial(t *testing.T) {
	if RuneLen("héllo") != 5 || Initial("été") != "é" || Initial("") != "" {
		t.Fatal("rune helpers broken")
	}
}
