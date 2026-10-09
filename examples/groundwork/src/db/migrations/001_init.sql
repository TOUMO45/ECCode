-- 001_init.sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE teams (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL);
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  username TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(username) BETWEEN 1 AND 64),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  role TEXT NOT NULL CHECK (role IN ('viewer','responder','lead')),
  password_hash TEXT NOT NULL,           -- scrypt$N$r$p$saltB64$hashB64
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  created_at TEXT NOT NULL);
CREATE INDEX idx_users_team ON users(team_id);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,               -- sha256 hex of the cookie value
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE TABLE incidents (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 140),
  severity TEXT NOT NULL CHECK (severity IN ('SEV1','SEV2','SEV3','SEV4')),
  started_at TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  notes_rev INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL);
CREATE INDEX idx_incidents_team ON incidents(team_id, id DESC);
CREATE TABLE note_lines (
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  n INTEGER NOT NULL CHECK (n >= 1),
  time TEXT NOT NULL,                      -- HH:MM
  ts TEXT,                                 -- raw ISO string when given
  author TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 64),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  PRIMARY KEY (incident_id, n)) WITHOUT ROWID;
CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,
  incident_id INTEGER NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published')),
  provider TEXT NOT NULL, model TEXT, is_fallback INTEGER NOT NULL CHECK (is_fallback IN (0,1)),
  prompt_version TEXT,
  generated_at TEXT NOT NULL,
  published_at TEXT, published_by INTEGER REFERENCES users(id),
  CHECK ((state='published') = (published_at IS NOT NULL)));
CREATE INDEX idx_drafts_team_state ON drafts(team_id, state, published_at DESC);
CREATE TABLE statements (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  section TEXT NOT NULL CHECK (section IN ('summary','impact','timeline','contributingFactors','actionItems')),
  position INTEGER NOT NULL,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 600),
  cites TEXT NOT NULL,                     -- JSON array of integers
  status TEXT NOT NULL CHECK (status IN ('verified','flagged')),  -- cache only; never trusted at publish
  reasons TEXT NOT NULL DEFAULT '[]',      -- JSON array
  edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0,1)));
CREATE INDEX idx_statements_draft ON statements(draft_id, section, position);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  team_id INTEGER,                         -- null for failures with unknown user
  actor_user_id INTEGER, actor_name TEXT,  -- submitted username for failed logins (<=64 chars)
  action TEXT NOT NULL, target_type TEXT, target_id INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','denied','fail')),
  ip TEXT, request_id TEXT, detail TEXT NOT NULL DEFAULT '{}');
CREATE INDEX idx_audit_team ON audit_log(team_id, id DESC);
