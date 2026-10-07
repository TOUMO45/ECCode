#!/bin/sh
# t07-ui: mutation check. Each mutation of public/ must make test/unit/ui.test.js fail.
# Copies public/ and the test into a temp dir; never edits the real files. Exit 1 if any mutation survives.
P=$(pwd)
T=$(mktemp -d)
survived=0
check() {
  rm -rf "$T"/*; mkdir -p "$T/test/unit" "$T/public"
  cp "$P"/public/* "$T/public/"; cp "$P/test/unit/ui.test.js" "$T/test/unit/"
  sh -c "$1"
  if node --test "$T/test/unit/ui.test.js" >/dev/null 2>&1; then echo "SURVIVED: $2"; survived=1; else echo "killed:   $2"; fi
}
check "sed -i 's/textContent = text;/innerHTML = text;/' $T/public/app.js" "innerHTML sink (AC11)"
check "sed -i 's/not AI-generated/not AI generated/' $T/public/app.js" "fallback label wording (AC5)"
check "sed -i \"s#fetch('/api/health')#fetch('https://evil.example/api/health')#\" $T/public/app.js" "external fetch target (AC6)"
check "sed -i 's/if (state.busy) return;//' $T/public/app.js" "busy guard removed (NFR5)"
check "sed -i 's/result.hidden = true;/void 0;/' $T/public/app.js" "error state keeps old result"
check "sed -i 's/--fallback-bg: #fff4ce/--fallback-bg: #8a7a3a/' $T/public/styles.css" "fallback badge contrast"
check "sed -i 's/ aria-live=\"polite\"//' $T/public/index.html" "live region removed (NFR6)"
check "sed -i 's#<label for=\"reply\">Suggested reply (editable)</label>##' $T/public/index.html" "reply label removed (AC6)"
check "sed -i 's/reply.value = state.original;//' $T/public/app.js" "Reset broken (AC6)"
check "sed -i 's/Names, addresses and other details are not removed\.//' $T/public/index.html" "NFR4 notice altered (AC16)"
check "sed -i 's/warning.hidden = body.injectionSuspected !== true;//' $T/public/app.js" "injection warning never shown (R8)"
rm -rf "$T"
exit $survived
