CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  username TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
