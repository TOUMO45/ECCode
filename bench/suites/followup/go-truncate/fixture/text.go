// Package textx holds the string helpers shared by the notification jobs.
package textx

import "unicode/utf8"

// RuneLen returns the number of runes (not bytes) in s.
func RuneLen(s string) int {
	return utf8.RuneCountInString(s)
}

// Initial returns the first rune of s as a string, or "" for an empty s.
func Initial(s string) string {
	for _, r := range s {
		return string(r)
	}
	return ""
}
