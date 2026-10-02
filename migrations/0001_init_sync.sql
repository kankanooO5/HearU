CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vocabulary_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  course TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('classroom', 'conversation')),
  language TEXT NOT NULL CHECK (language IN ('it', 'zh')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration REAL NOT NULL DEFAULT 0,
  vocabulary_json TEXT NOT NULL DEFAULT '[]',
  chunks INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE lines (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  line_order INTEGER NOT NULL,
  start REAL NOT NULL,
  end REAL NOT NULL,
  stable TEXT NOT NULL DEFAULT '',
  active TEXT NOT NULL DEFAULT '',
  locked INTEGER NOT NULL DEFAULT 0,
  translation TEXT NOT NULL DEFAULT '',
  translated_chars INTEGER NOT NULL DEFAULT 0,
  last_queued_at REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id)
    REFERENCES sessions(id)
    ON DELETE CASCADE
);

CREATE INDEX sessions_started_at
  ON sessions(started_at DESC);

CREATE INDEX lines_session_order
  ON lines(session_id, line_order);
