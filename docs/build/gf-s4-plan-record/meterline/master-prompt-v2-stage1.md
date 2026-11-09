We manage about 50 buildings and get electricity meter readings as CSV files dropped in a folder,
sometimes late, sometimes duplicated, sometimes with broken rows.
I want a system that picks up the files, cleans them, stores the readings and computes daily usage per building.
Flag readings that go backwards and meters that stop reporting.
Building managers should log in and see only their buildings; we (the operators) see everything.
A simple web page listing daily usage and alerts is enough for now, plus an API so our billing system can pull the daily numbers.
It must run with docker compose and survive restarts without losing or double-counting data.
Use whatever stack you think is best.

Readings arrive as CSV files. A sample file, sample_readings.csv, is attached; real files
follow the same columns: building_id, meter_id, timestamp_utc (ISO 8601, UTC),
reading_kwh (energy used in that 15-minute interval).
