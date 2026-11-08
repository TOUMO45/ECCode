"""Probe adapter shim (comparator record). Stands in for the engine app's in-process factory so the S3 review-probe
test bodies run unchanged against ANY tree that starts with `uvicorn app.main:app` and reads its settings from env vars."""
