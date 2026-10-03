import {
  listCourses,
  listLines,
  listPendingSessionDeletions,
  listSessions,
  purgeLocalSession,
  removePendingSessionDeletion,
  saveCourse,
  saveLine,
  saveSession,
  type Course,
  type SavedLine,
  type SavedSession,
} from "./db";

const STORAGE_KEY = "hearu-sync-key";

type Synced<T> = T & {
  updatedAt: number;
};

type SyncTombstone = {
  sessionId: string;
  deletedAt: number;
};

type PullResult = {
  courses: Array<Synced<Course>>;
  sessions: Array<Synced<SavedSession>>;
  lines: Array<Synced<SavedLine>>;
  tombstones: SyncTombstone[];
};

export function getSyncKey(): string {
  return localStorage
    .getItem(STORAGE_KEY)
    ?.trim() || "";
}

export function setSyncKey(
  value: string,
): void {
  const key = value.trim();

  if (key) {
    localStorage.setItem(
      STORAGE_KEY,
      key,
    );
  } else {
    localStorage.removeItem(
      STORAGE_KEY,
    );
  }
}

export function hasSyncKey(): boolean {
  return Boolean(getSyncKey());
}

async function request(
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const key = getSyncKey();

  if (!key) {
    throw new Error(
      "尚未配置 HearU Sync Key",
    );
  }

  const response = await fetch(path, {
    ...init,
    headers: {
      ...init.headers,
      "x-hearu-sync-key": key,
    },
  });

  const result = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result.error ||
        `同步服务响应 ${response.status}`,
    );
  }

  return result;
}

async function pull(
  sessionId?: string,
): Promise<PullResult> {
  const query = sessionId
    ? `?session=${encodeURIComponent(
        sessionId,
      )}`
    : "";

  return request(
    `/api/sync/pull${query}`,
  );
}

async function push(
  body: {
    courses?: Array<Synced<Course>>;
    sessions?: Array<Synced<SavedSession>>;
    lines?: Array<Synced<SavedLine>>;
  },
): Promise<void> {
  await request(
    "/api/sync/push",
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

async function pushPendingSessionDeletions():
  Promise<void> {
  const pending =
    await listPendingSessionDeletions();

  if (!pending.length) {
    return;
  }

  await request(
    "/api/sync/delete",
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json",
      },
      body: JSON.stringify({
        tombstones: pending,
      }),
    },
  );

  /*
   * /api/sync/delete 是幂等的。
   * 服务端确认后才能移除本地待同步任务。
   */
  await Promise.all(
    pending.map(
      item =>
        removePendingSessionDeletion(
          item.sessionId,
        ),
    ),
  );
}

async function ensureTimestamp<
  T extends {
    updatedAt?: number;
  },
>(
  item: T,
  save: (
    value: T & {
      updatedAt: number;
    },
  ) => Promise<unknown>,
): Promise<
  T & {
    updatedAt: number;
  }
> {
  if (
    typeof item.updatedAt === "number"
  ) {
    return item as T & {
      updatedAt: number;
    };
  }

  const stamped = {
    ...item,
    updatedAt: Date.now(),
  };

  await save(stamped);

  return stamped;
}

function isRemoteNewer(
  remote: {
    updatedAt: number;
  },
  local?: {
    updatedAt?: number;
  },
): boolean {
  return (
    !local ||
    remote.updatedAt >
      (local.updatedAt || 0)
  );
}

export async function syncIndex(): Promise<{
  courses: Course[];
  sessions: SavedSession[];
}> {
  await pushPendingSessionDeletions();

  const [
    localCoursesRaw,
    localSessionsRaw,
  ] = await Promise.all([
    listCourses(),
    listSessions(),
  ]);

  const localCourses =
    await Promise.all(
      localCoursesRaw.map(
        (course) =>
          ensureTimestamp(
            course,
            saveCourse,
          ),
      ),
    );

  const localSessions =
    await Promise.all(
      localSessionsRaw.map(
        (session) =>
          ensureTimestamp(
            session,
            saveSession,
          ),
      ),
    );

  const remote = await pull();

  const tombstonedIds =
    new Set(
      remote.tombstones.map(
        item =>
          item.sessionId,
      ),
    );

  /*
   * 云端永久删除优先级最高。
   * 本机哪怕还留着旧副本，也必须清除。
   */
  for (
    const tombstone of
    remote.tombstones
  ) {
    await purgeLocalSession(
      tombstone.sessionId,
    );
  }

  const localCourseMap =
    new Map(
      localCourses.map(
        (course) => [
          course.id,
          course,
        ],
      ),
    );

  const localSessionMap =
    new Map(
      localSessions
        .filter(
          session =>
            !tombstonedIds.has(
              session.id,
            ),
        )
        .map(
          (session) => [
            session.id,
            session,
          ],
        ),
    );

  for (
    const course of
    remote.courses
  ) {
    const local =
      localCourseMap.get(course.id);

    if (
      isRemoteNewer(
        course,
        local,
      )
    ) {
      await saveCourse(course);

      localCourseMap.set(
        course.id,
        course,
      );
    }
  }

  for (
    const session of
    remote.sessions
  ) {
    if (
      tombstonedIds.has(
        session.id,
      )
    ) {
      continue;
    }

    const local =
      localSessionMap.get(
        session.id,
      );

    if (
      isRemoteNewer(
        session,
        local,
      )
    ) {
      const imported = {
        ...session,
        chunks:
          local?.chunks || 0,
      };

      await saveSession(imported);

      localSessionMap.set(
        session.id,
        imported,
      );
    }
  }

  const remoteCourseMap =
    new Map(
      remote.courses.map(
        (course) => [
          course.id,
          course,
        ],
      ),
    );

  const remoteSessionMap =
    new Map(
      remote.sessions.map(
        (session) => [
          session.id,
          session,
        ],
      ),
    );

  const coursesToPush =
    [...localCourseMap.values()]
      .filter((course) => {
        const cloud =
          remoteCourseMap.get(
            course.id,
          );

        return (
          !cloud ||
          (course.updatedAt || 0) >
            cloud.updatedAt
        );
      })
      .map(
        (course) =>
          course as Synced<Course>,
      );

  const sessionsToPush =
    [...localSessionMap.values()]
      .filter((session) => {
        const cloud =
          remoteSessionMap.get(
            session.id,
          );

        return (
          !cloud ||
          (session.updatedAt || 0) >
            cloud.updatedAt
        );
      })
      .map((session) => ({
        ...session,
        chunks: 0,
      })) as Array<
        Synced<SavedSession>
      >;

  if (
    coursesToPush.length ||
    sessionsToPush.length
  ) {
    await push({
      courses: coursesToPush,
      sessions: sessionsToPush,
    });
  }

  return {
    courses:
      [...localCourseMap.values()],
    sessions:
      [...localSessionMap.values()],
  };
}

export async function syncSessionLines(
  sessionId: string,
): Promise<SavedLine[]> {
  await pushPendingSessionDeletions();

  const localRaw =
    await listLines(sessionId);

  const local =
    await Promise.all(
      localRaw.map(
        (line) =>
          ensureTimestamp(
            line,
            saveLine,
          ),
      ),
    );

  const remote =
    await pull(sessionId);

  if (
    remote.tombstones.some(
      item =>
        item.sessionId ===
        sessionId,
    )
  ) {
    await purgeLocalSession(
      sessionId,
    );

    return [];
  }

  const localMap =
    new Map(
      local.map(
        (line) => [
          line.id,
          line,
        ],
      ),
    );

  for (
    const line of remote.lines
  ) {
    const current =
      localMap.get(line.id);

    if (
      isRemoteNewer(
        line,
        current,
      )
    ) {
      await saveLine(line);

      localMap.set(
        line.id,
        line,
      );
    }
  }

  const remoteMap =
    new Map(
      remote.lines.map(
        (line) => [
          line.id,
          line,
        ],
      ),
    );

  const linesToPush =
    [...localMap.values()]
      .filter((line) => {
        const cloud =
          remoteMap.get(line.id);

        return (
          !cloud ||
          (line.updatedAt || 0) >
            cloud.updatedAt
        );
      })
      .map(
        (line) =>
          line as Synced<SavedLine>,
      );

  for (
    let i = 0;
    i < linesToPush.length;
    i += 500
  ) {
    await push({
      lines:
        linesToPush.slice(
          i,
          i + 500,
        ),
    });
  }

  return [...localMap.values()]
    .sort(
      (a, b) =>
        a.order - b.order,
    );
}

export async function syncAllHistory(): Promise<{
  courses: Course[];
  sessions: SavedSession[];
}> {
  const index = await syncIndex();

  for (const session of index.sessions) {
    await syncSessionLines(session.id);
  }

  return index;
}
