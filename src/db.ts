import type { CaptionLine } from './caption-engine';

export type Course = {
  id: string;
  name: string;
  vocabulary: string[];
  updatedAt?: number;
};

export type SavedSession = {
  id: string;

  /*
   * course 保留课程原始名称。
   * title 是记录展示标题：
   * - 可由 AI 自动生成
   * - 可由用户手动修改
   * - 后续会参与跨设备同步
   */
  course: string;
  title?: string;

  mode: 'classroom' | 'conversation';
  language: 'it' | 'zh';

  startedAt: string;
  endedAt?: string;

  duration: number;
  vocabulary: string[];
  chunks: number;

  updatedAt?: number;
};

export type SavedLine =
  CaptionLine & {
    sessionId: string;
    updatedAt?: number;
  };

export type AudioChunk = {
  key: string;
  sessionId: string;
  index: number;
  blob: Blob;
  format: string;
};

/*
 * 纯本地状态。
 *
 * 这里的数据永远不直接上传云端。
 * 因此“移入回收站”不会影响其他设备。
 */
export type SessionLocalState = {
  sessionId: string;
  trashedAt?: number;
};

export type PendingSessionDeletion = {
  sessionId: string;
  deletedAt: number;
};

const NAME =
  'tingjian-classroom-v1';

const VERSION = 3;

let opening:
  Promise<IDBDatabase> | null =
  null;

function db():
  Promise<IDBDatabase> {
  if (!opening) {
    opening =
      new Promise(
        (
          resolve,
          reject,
        ) => {
          const request =
            indexedDB.open(
              NAME,
              VERSION,
            );

          request.onupgradeneeded =
            () => {
              const database =
                request.result;

              if (
                !database.objectStoreNames.contains(
                  'courses',
                )
              ) {
                database.createObjectStore(
                  'courses',
                  {
                    keyPath: 'id',
                  },
                );
              }

              if (
                !database.objectStoreNames.contains(
                  'sessions',
                )
              ) {
                database.createObjectStore(
                  'sessions',
                  {
                    keyPath: 'id',
                  },
                );
              }

              if (
                !database.objectStoreNames.contains(
                  'lines',
                )
              ) {
                database
                  .createObjectStore(
                    'lines',
                    {
                      keyPath: [
                        'sessionId',
                        'id',
                      ],
                    },
                  )
                  .createIndex(
                    'sessionId',
                    'sessionId',
                  );
              }

              if (
                !database.objectStoreNames.contains(
                  'audio',
                )
              ) {
                database
                  .createObjectStore(
                    'audio',
                    {
                      keyPath: 'key',
                    },
                  )
                  .createIndex(
                    'sessionId',
                    'sessionId',
                  );
              }

              if (
                !database.objectStoreNames.contains(
                  'sessionState',
                )
              ) {
                database.createObjectStore(
                  'sessionState',
                  {
                    keyPath:
                      'sessionId',
                  },
                );
              }

              if (
                !database.objectStoreNames.contains(
                  'deletions',
                )
              ) {
                database.createObjectStore(
                  'deletions',
                  {
                    keyPath:
                      'sessionId',
                  },
                );
              }
            };

          request.onsuccess =
            () =>
              resolve(
                request.result,
              );

          request.onerror =
            () => {
              opening = null;

              reject(
                request.error,
              );
            };
        },
      );
  }

  return opening;
}

function transaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (
    store: IDBObjectStore,
  ) => IDBRequest<T>,
): Promise<T> {
  return db().then(
    database =>
      new Promise(
        (
          resolve,
          reject,
        ) => {
          const tx =
            database.transaction(
              storeName,
              mode,
            );

          const req =
            action(
              tx.objectStore(
                storeName,
              ),
            );

          let value: T;

          req.onsuccess =
            () => {
              value =
                req.result;
            };

          tx.oncomplete =
            () =>
              resolve(value);

          tx.onerror =
            () =>
              reject(
                tx.error,
              );

          tx.onabort =
            () =>
              reject(
                tx.error,
              );
        },
      ),
  );
}

function timestamp<
  T extends {
    updatedAt?: number;
  },
>(
  value: T,
): T & {
  updatedAt: number;
} {
  return {
    ...value,
    updatedAt:
      value.updatedAt ??
      Date.now(),
  };
}

export const saveCourse = (
  value: Course,
) =>
  transaction(
    'courses',
    'readwrite',
    store =>
      store.put(
        timestamp(value),
      ),
  );

export const listCourses =
  () =>
    transaction<Course[]>(
      'courses',
      'readonly',
      store =>
        store.getAll(),
    );

export const saveSession = (
  value: SavedSession,
) =>
  transaction(
    'sessions',
    'readwrite',
    store =>
      store.put(
        timestamp(value),
      ),
  );

export const listSessions =
  () =>
    transaction<
      SavedSession[]
    >(
      'sessions',
      'readonly',
      store =>
        store.getAll(),
    );

export const saveLine = (
  value: SavedLine,
) =>
  transaction(
    'lines',
    'readwrite',
    store =>
      store.put(
        timestamp(value),
      ),
  );

export const listLines = (
  id: string,
) =>
  transaction<
    SavedLine[]
  >(
    'lines',
    'readonly',
    store =>
      store
        .index(
          'sessionId',
        )
        .getAll(id),
  );

export const saveAudio = (
  value: AudioChunk,
) =>
  transaction(
    'audio',
    'readwrite',
    store =>
      store.put(value),
  );

/* =========================================================
   Local-only session state
   ========================================================= */

export const listSessionStates =
  () =>
    transaction<
      SessionLocalState[]
    >(
      'sessionState',
      'readonly',
      store =>
        store.getAll(),
    );

export const getSessionState = (
  sessionId: string,
) =>
  transaction<
    SessionLocalState
  >(
    'sessionState',
    'readonly',
    store =>
      store.get(
        sessionId,
      ),
  );

export const moveSessionToTrash = (
  sessionId: string,
) =>
  transaction(
    'sessionState',
    'readwrite',
    store =>
      store.put({
        sessionId,
        trashedAt:
          Date.now(),
      }),
  );

export const restoreSessionFromTrash = (
  sessionId: string,
) =>
  transaction(
    'sessionState',
    'readwrite',
    store =>
      store.delete(
        sessionId,
      ),
  );


/* =========================================================
   Permanent deletion queue
   ========================================================= */

export const listPendingSessionDeletions =
  () =>
    transaction<
      PendingSessionDeletion[]
    >(
      'deletions',
      'readonly',
      store =>
        store.getAll(),
    );

export const removePendingSessionDeletion = (
  sessionId: string,
) =>
  transaction(
    'deletions',
    'readwrite',
    store =>
      store.delete(
        sessionId,
      ),
  );

async function deleteLocalSessionData(
  sessionId: string,
  pendingDeletion:
    PendingSessionDeletion | null,
): Promise<void> {
  const database =
    await db();

  await new Promise<void>(
    (
      resolve,
      reject,
    ) => {
      const tx =
        database.transaction(
          [
            'sessions',
            'lines',
            'audio',
            'sessionState',
            'deletions',
          ],
          'readwrite',
        );

      const sessions =
        tx.objectStore(
          'sessions',
        );

      const lines =
        tx.objectStore(
          'lines',
        );

      const audio =
        tx.objectStore(
          'audio',
        );

      const state =
        tx.objectStore(
          'sessionState',
        );

      const deletions =
        tx.objectStore(
          'deletions',
        );

      if (pendingDeletion) {
        /*
         * 本机主动永久删除：
         * 先留下待上传 tombstone。
         */
        deletions.put(
          pendingDeletion,
        );
      } else {
        /*
         * 云端已经确认删除：
         * 本机无需继续保留待上传任务。
         */
        deletions.delete(
          sessionId,
        );
      }

      sessions.delete(
        sessionId,
      );

      state.delete(
        sessionId,
      );

      const deleteByIndex = (
        store: IDBObjectStore,
        indexName: string,
      ) => {
        const request =
          store
            .index(indexName)
            .openCursor(
              IDBKeyRange.only(
                sessionId,
              ),
            );

        request.onsuccess =
          () => {
            const cursor =
              request.result;

            if (!cursor) {
              return;
            }

            cursor.delete();
            cursor.continue();
          };
      };

      deleteByIndex(
        lines,
        'sessionId',
      );

      deleteByIndex(
        audio,
        'sessionId',
      );

      tx.oncomplete =
        () => resolve();

      tx.onerror =
        () =>
          reject(tx.error);

      tx.onabort =
        () =>
          reject(tx.error);
    },
  );
}

export function permanentlyDeleteLocalSession(
  sessionId: string,
  deletedAt = Date.now(),
): Promise<void> {
  return deleteLocalSessionData(
    sessionId,
    {
      sessionId,
      deletedAt,
    },
  );
}

/*
 * 收到云端 tombstone 时使用。
 * 不再创建新的待上传删除任务。
 */
export function purgeLocalSession(
  sessionId: string,
): Promise<void> {
  return deleteLocalSessionData(
    sessionId,
    null,
  );
}

