CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
ALTER TABLE plans ADD COLUMN household_id TEXT REFERENCES households(id);
