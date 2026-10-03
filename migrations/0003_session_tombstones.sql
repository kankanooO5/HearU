CREATE TABLE session_tombstones (
  session_id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);

CREATE INDEX session_tombstones_deleted_at
  ON session_tombstones(deleted_at DESC);
