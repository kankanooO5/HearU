import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const dbSource = `
const courses = new Map();
const sessions = new Map();
const lines = new Map();

export function __reset() {
  courses.clear();
  sessions.clear();
  lines.clear();
}

export function __seed(data = {}) {
  for (const x of data.courses || []) {
    courses.set(x.id, structuredClone(x));
  }

  for (const x of data.sessions || []) {
    sessions.set(x.id, structuredClone(x));
  }

  for (const x of data.lines || []) {
    lines.set(
      x.sessionId + "|" + x.id,
      structuredClone(x),
    );
  }
}

export function __snapshot() {
  return {
    courses: [...courses.values()].map(x => structuredClone(x)),
    sessions: [...sessions.values()].map(x => structuredClone(x)),
    lines: [...lines.values()].map(x => structuredClone(x)),
  };
}

export async function saveCourse(x) {
  courses.set(x.id, structuredClone(x));
}

export async function listCourses() {
  return [...courses.values()].map(x => structuredClone(x));
}

export async function saveSession(x) {
  sessions.set(x.id, structuredClone(x));
}

export async function listSessions() {
  return [...sessions.values()].map(x => structuredClone(x));
}

export async function saveLine(x) {
  lines.set(
    x.sessionId + "|" + x.id,
    structuredClone(x),
  );
}

export async function listLines(sessionId) {
  return [...lines.values()]
    .filter(x => x.sessionId === sessionId)
    .map(x => structuredClone(x));
}
`;

const dbUrl =
  `data:text/javascript;base64,${Buffer.from(dbSource).toString("base64")}`;

const syncSource = readFileSync(
  new URL("../src/sync.ts", import.meta.url),
  "utf8",
);

let syncJs = ts.transpileModule(
  syncSource,
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

syncJs = syncJs.replace(
  /from\s+["']\.\/db["'];/,
  `from "${dbUrl}";`,
);

const sync = await import(
  `data:text/javascript;base64,${Buffer.from(syncJs).toString("base64")}`
);

const db = await import(dbUrl);

const storage = new Map();

Object.defineProperty(
  globalThis,
  "localStorage",
  {
    configurable: true,
    value: {
      getItem(key) {
        return storage.has(key)
          ? storage.get(key)
          : null;
      },

      setItem(key, value) {
        storage.set(
          key,
          String(value),
        );
      },

      removeItem(key) {
        storage.delete(key);
      },

      clear() {
        storage.clear();
      },
    },
  },
);

function createRemote(seed = {}) {
  const courses = new Map();
  const sessions = new Map();
  const lines = new Map();

  for (const x of seed.courses || []) {
    courses.set(
      x.id,
      structuredClone(x),
    );
  }

  for (const x of seed.sessions || []) {
    sessions.set(
      x.id,
      structuredClone(x),
    );
  }

  for (const x of seed.lines || []) {
    lines.set(
      x.sessionId + "|" + x.id,
      structuredClone(x),
    );
  }

  function upsert(map, key, item) {
    const current = map.get(key);

    if (
      !current ||
      item.updatedAt >= current.updatedAt
    ) {
      map.set(
        key,
        structuredClone(item),
      );
    }
  }

  globalThis.fetch = async (
    input,
    init = {},
  ) => {
    const headers =
      new Headers(init.headers);

    if (
      headers.get(
        "x-hearu-sync-key",
      ) !== "sync-test"
    ) {
      return Response.json(
        {
          error:
            "同步凭证未通过验证",
        },
        {
          status: 401,
        },
      );
    }

    const url = new URL(
      String(input),
      "https://example.test",
    );

    if (
      url.pathname ===
      "/api/sync/pull"
    ) {
      const sessionId =
        url.searchParams.get(
          "session",
        );

      return Response.json({
        courses:
          [...courses.values()]
            .map(x => structuredClone(x)),

        sessions:
          [...sessions.values()]
            .map(x => structuredClone(x)),

        lines:
          sessionId
            ? [...lines.values()]
                .filter(
                  x =>
                    x.sessionId ===
                    sessionId,
                )
                .sort(
                  (a, b) =>
                    a.order -
                    b.order,
                )
                .map(
                  x => structuredClone(x),
                )
            : [],
      });
    }

    if (
      url.pathname ===
      "/api/sync/push"
    ) {
      const body =
        JSON.parse(init.body);

      for (
        const course of
        body.courses || []
      ) {
        upsert(
          courses,
          course.id,
          course,
        );
      }

      for (
        const session of
        body.sessions || []
      ) {
        upsert(
          sessions,
          session.id,
          session,
        );
      }

      for (
        const line of
        body.lines || []
      ) {
        upsert(
          lines,
          line.sessionId +
            "|" +
            line.id,
          line,
        );
      }

      return Response.json({
        ok: true,
      });
    }

    throw new Error(
      `Unexpected fetch: ${url}`,
    );
  };

  return {
    snapshot() {
      return {
        courses:
          [...courses.values()]
            .map(x => structuredClone(x)),

        sessions:
          [...sessions.values()]
            .map(x => structuredClone(x)),

        lines:
          [...lines.values()]
            .map(x => structuredClone(x)),
      };
    },
  };
}

function session(
  overrides = {},
) {
  return {
    id: "session-1",
    course: "Roman History",
    mode: "classroom",
    language: "it",
    startedAt:
      "2026-10-03T09:00:00.000Z",
    duration: 60,
    vocabulary: ["Augusto"],
    chunks: 3,
    ...overrides,
  };
}

test(
  "first sync uploads local index while keeping local audio chunk count",
  async () => {
    db.__reset();
    storage.clear();

    sync.setSyncKey(
      "sync-test",
    );

    db.__seed({
      courses: [
        {
          id: "roman-history",
          name: "Roman History",
          vocabulary: [
            "Augusto",
          ],
        },
      ],
      sessions: [
        session(),
      ],
    });

    const remote =
      createRemote();

    await sync.syncIndex();

    const local =
      db.__snapshot();

    const cloud =
      remote.snapshot();

    assert.equal(
      typeof local.courses[0]
        .updatedAt,
      "number",
    );

    assert.equal(
      typeof local.sessions[0]
        .updatedAt,
      "number",
    );

    assert.equal(
      cloud.courses[0].name,
      "Roman History",
    );

    assert.equal(
      cloud.sessions[0].course,
      "Roman History",
    );

    assert.equal(
      cloud.sessions[0].chunks,
      0,
    );

    assert.equal(
      local.sessions[0].chunks,
      3,
    );
  },
);

test(
  "an empty device imports cloud index and session lines",
  async () => {
    db.__reset();
    storage.clear();

    sync.setSyncKey(
      "sync-test",
    );

    createRemote({
      courses: [
        {
          id: "roman-history",
          name: "Roman History",
          vocabulary: [
            "Augusto",
          ],
          updatedAt: 200,
        },
      ],

      sessions: [
        session({
          chunks: 0,
          updatedAt: 200,
        }),
      ],

      lines: [
        {
          sessionId:
            "session-1",
          id: "line-1",
          order: 0,
          start: 0,
          end: 3,
          stable:
            "Augusto.",
          active: "",
          locked: true,
          translation:
            "奥古斯都。",
          translatedChars: 8,
          lastQueuedAt: 0,
          updatedAt: 200,
        },
      ],
    });

    await sync.syncIndex();

    const lines =
      await sync.syncSessionLines(
        "session-1",
      );

    const local =
      db.__snapshot();

    assert.equal(
      local.courses[0].name,
      "Roman History",
    );

    assert.equal(
      local.sessions[0].course,
      "Roman History",
    );

    assert.equal(
      local.sessions[0].chunks,
      0,
    );

    assert.equal(
      lines[0].stable,
      "Augusto.",
    );

    assert.equal(
      lines[0].translation,
      "奥古斯都。",
    );
  },
);

test(
  "newer updatedAt wins in both directions",
  async () => {
    db.__reset();
    storage.clear();

    sync.setSyncKey(
      "sync-test",
    );

    db.__seed({
      sessions: [
        session({
          course:
            "Local newer",
          updatedAt: 300,
        }),
      ],
    });

    const remote =
      createRemote({
        sessions: [
          session({
            course:
              "Cloud older",
            chunks: 0,
            updatedAt: 200,
          }),
        ],
      });

    await sync.syncIndex();

    assert.equal(
      remote.snapshot()
        .sessions[0].course,
      "Local newer",
    );

    db.__reset();

    db.__seed({
      sessions: [
        session({
          course:
            "Local older",
          updatedAt: 100,
        }),
      ],
    });

    createRemote({
      sessions: [
        session({
          course:
            "Cloud newer",
          chunks: 0,
          updatedAt: 400,
        }),
      ],
    });

    await sync.syncIndex();

    const local =
      db.__snapshot();

    assert.equal(
      local.sessions[0].course,
      "Cloud newer",
    );

    assert.equal(
      local.sessions[0].updatedAt,
      400,
    );

    assert.equal(
      local.sessions[0].chunks,
      3,
    );
  },
);
