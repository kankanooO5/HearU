import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(
  new URL("../worker/index.ts", import.meta.url),
  "utf8",
);

const js = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const worker = (
  await import(
    `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
  )
).default;

class FakeStatement {
  constructor(db, sql, values = []) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.values = values;
  }

  bind(...values) {
    return new FakeStatement(
      this.db,
      this.sql,
      values,
    );
  }

  async all() {
    if (this.sql.includes("FROM courses")) {
      return {
        results: [...this.db.courses.values()]
          .sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
      };
    }

    if (this.sql.includes("FROM sessions")) {
      return {
        results: [...this.db.sessions.values()]
          .sort((a, b) =>
            b.started_at.localeCompare(
              a.started_at,
            ),
          ),
      };
    }

    if (this.sql.includes("FROM lines")) {
      const sessionId = this.values[0];

      return {
        results: [...this.db.lines.values()]
          .filter(
            (line) =>
              line.session_id === sessionId,
          )
          .sort(
            (a, b) =>
              a.line_order - b.line_order,
          ),
      };
    }

    throw new Error(
      `Unexpected SELECT: ${this.sql}`,
    );
  }
}

class FakeD1 {
  courses = new Map();
  sessions = new Map();
  lines = new Map();

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    for (const statement of statements) {
      const sql = statement.sql;
      const v = statement.values;

      if (sql.includes("INSERT INTO courses")) {
        const row = {
          id: v[0],
          name: v[1],
          vocabulary_json: v[2],
          updated_at: v[3],
        };

        const old = this.courses.get(row.id);

        if (
          !old ||
          row.updated_at >= old.updated_at
        ) {
          this.courses.set(row.id, row);
        }

        continue;
      }

      if (sql.includes("INSERT INTO sessions")) {
        const row = {
          id: v[0],
          course: v[1],
          mode: v[2],
          language: v[3],
          started_at: v[4],
          ended_at: v[5],
          duration: v[6],
          vocabulary_json: v[7],
          chunks: v[8],
          updated_at: v[9],
        };

        const old = this.sessions.get(row.id);

        if (
          !old ||
          row.updated_at >= old.updated_at
        ) {
          this.sessions.set(row.id, row);
        }

        continue;
      }

      if (sql.includes("INSERT INTO lines")) {
        const row = {
          session_id: v[0],
          id: v[1],
          line_order: v[2],
          start: v[3],
          end: v[4],
          stable: v[5],
          active: v[6],
          locked: v[7],
          translation: v[8],
          translated_chars: v[9],
          last_queued_at: v[10],
          updated_at: v[11],
        };

        const key =
          `${row.session_id}|${row.id}`;

        const old = this.lines.get(key);

        if (
          !old ||
          row.updated_at >= old.updated_at
        ) {
          this.lines.set(key, row);
        }

        continue;
      }

      throw new Error(
        `Unexpected INSERT: ${sql}`,
      );
    }

    return [];
  }
}

function request(
  path,
  {
    method = "GET",
    key,
    body,
  } = {},
) {
  const headers = {};

  if (key) {
    headers["x-hearu-sync-key"] = key;
  }

  if (body !== undefined) {
    headers["content-type"] =
      "application/json";
  }

  return new Request(
    `https://example.test${path}`,
    {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : JSON.stringify(body),
    },
  );
}

test(
  "sync requires the configured sync key",
  async () => {
    const db = new FakeD1();

    const missingSetup =
      await worker.fetch(
        request("/api/sync/pull"),
        { hearu_sync: db },
      );

    assert.equal(
      missingSetup.status,
      503,
    );

    const wrongKey =
      await worker.fetch(
        request(
          "/api/sync/pull",
          { key: "wrong" },
        ),
        {
          hearu_sync: db,
          SYNC_KEY: "correct",
        },
      );

    assert.equal(
      wrongKey.status,
      401,
    );
  },
);

test(
  "sync push and pull preserve newest records",
  async () => {
    const db = new FakeD1();

    const env = {
      hearu_sync: db,
      SYNC_KEY: "sync-test",
    };

    const first =
      await worker.fetch(
        request(
          "/api/sync/push",
          {
            method: "POST",
            key: "sync-test",
            body: {
              courses: [
                {
                  id: "roman-history",
                  name: "Roman History",
                  vocabulary: ["Augusto"],
                  updatedAt: 100,
                },
              ],
              sessions: [
                {
                  id: "session-1",
                  course: "Roman History",
                  mode: "classroom",
                  language: "it",
                  startedAt:
                    "2026-10-03T09:00:00.000Z",
                  duration: 60,
                  vocabulary: ["Augusto"],
                  chunks: 2,
                  updatedAt: 100,
                },
              ],
              lines: [
                {
                  sessionId: "session-1",
                  id: "line-1",
                  order: 0,
                  start: 0,
                  end: 3,
                  stable: "Augusto.",
                  active: "",
                  locked: true,
                  translation: "奥古斯都。",
                  translatedChars: 8,
                  lastQueuedAt: 0,
                  updatedAt: 100,
                },
              ],
            },
          },
        ),
        env,
      );

    assert.equal(first.status, 200);

    const stale =
      await worker.fetch(
        request(
          "/api/sync/push",
          {
            method: "POST",
            key: "sync-test",
            body: {
              sessions: [
                {
                  id: "session-1",
                  course: "Old title",
                  mode: "classroom",
                  language: "it",
                  startedAt:
                    "2026-10-03T09:00:00.000Z",
                  duration: 10,
                  vocabulary: [],
                  chunks: 0,
                  updatedAt: 50,
                },
              ],
            },
          },
        ),
        env,
      );

    assert.equal(stale.status, 200);

    const pulled =
      await worker.fetch(
        request(
          "/api/sync/pull?session=session-1",
          { key: "sync-test" },
        ),
        env,
      );

    assert.equal(pulled.status, 200);

    const data = await pulled.json();

    assert.equal(
      data.courses[0].name,
      "Roman History",
    );

    assert.equal(
      data.sessions[0].course,
      "Roman History",
    );

    assert.equal(
      data.sessions[0].duration,
      60,
    );

    assert.equal(
      data.lines[0].stable,
      "Augusto.",
    );

    assert.equal(
      data.lines[0].translation,
      "奥古斯都。",
    );
  },
);
