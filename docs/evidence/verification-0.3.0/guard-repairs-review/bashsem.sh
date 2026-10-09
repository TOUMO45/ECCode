#!/usr/bin/env bash
# What bash really does with the forms probed in probes2.js (run in a scratch dir; writes only there).
D=${1:-/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/bashsem2}
rm -rf "$D"; mkdir -p "$D"; cd "$D" || exit 1
try() { mkdir -p .eccode; printf '%s  => ' "$1"; out=$(bash -c "$1" 2>&1); echo "rc=$? out=[$out]"; rm -rf .eccode; }
try '1e() { echo digitname "$@"; }; 1e a'
try 'é() { echo unicode "$@"; }; é a'
try 'e+() { echo plus "$@"; }; e+ a'
try 'e%() { echo pct "$@"; }; e% a'
try 'e.x() { echo dot "$@"; }; e.x a'
try 'N=NAME_Y; printf -v "$N" val; export "$N"; env | grep NAME_Y'
try 'declare -n ref=NAME_Z; ref=val; export ref; env | grep NAME_Z'
try "echo bin/\$'eccode'.js"
try "X=; echo bin/eccode.js\${X}"
try "echo bin/ecc\$''ode.js"
try 'echo x > .eccode/"state.json"; ls .eccode'
try "echo x > .ecc''ode/events.jsonl; ls .eccode"
try 'echo x > .eccode/\state.json; ls .eccode'
try 'mkdir -p .eccode/reviews; rm -rf .eccode/*; ls -A .eccode | wc -l'
try 'mkdir -p .eccode/reviews; rm -rf .eccode/reviews; ls -A .eccode | wc -l'
