-- 002_audit_append_only.sql
-- Audit rows are append-only: any UPDATE or DELETE aborts.
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
