Adapter calibration on the ENGINE-built tree (S3 bundle head c943799), before the bare run.
run-1/: 7 failed, 109 passed, 3 N/A. 6 = the S3 defect cases (R-1 x2, R-2, R-3, R-4, R-5); the 7th,
test_malformed_auth_headers["Bearer "], was an adapter artifact (502 LocalProtocolError: h11 refuses to send a header
value with trailing whitespace). Fix: the proxy strips header-value OWS (RFC 9110 5.5) before forwarding.
run 2 (this directory): 6 failed, 110 passed, 3 N/A = S3's 113 pass + 6 fail with the 3 engine-internal tests set aside.
Command: see docs/build/gf-s3-comparator-evidence.md section 9.
