import type { CaptionLine } from './caption-engine';
export type Course = { id: string; name: string; vocabulary: string[]; updatedAt?: number };
export type SavedSession = { id: string; course: string; mode: 'classroom' | 'conversation'; language: 'it' | 'zh'; startedAt: string; endedAt?: string; duration: number; vocabulary: string[]; chunks: number; updatedAt?: number };
export type SavedLine = CaptionLine & { sessionId: string; updatedAt?: number };
export type AudioChunk = { key: string; sessionId: string; index: number; blob: Blob; format: string };
const NAME = 'tingjian-classroom-v1';
let opening: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('courses', { keyPath: 'id' });
      database.createObjectStore('sessions', { keyPath: 'id' });
      database.createObjectStore('lines', { keyPath: ['sessionId', 'id'] }).createIndex('sessionId', 'sessionId');
      database.createObjectStore('audio', { keyPath: 'key' }).createIndex('sessionId', 'sessionId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = null; reject(request.error); };
  });
  return opening;
}
function transaction<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(database => new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    const req = action(tx.objectStore(storeName));
    let value: T;
    req.onsuccess = () => { value = req.result; };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}
function timestamp<T extends { updatedAt?: number }>(x: T): T & { updatedAt: number } {
  return {
    ...x,
    updatedAt: x.updatedAt ?? Date.now(),
  };
}

export const saveCourse = (x: Course) =>
  transaction('courses', 'readwrite', s => s.put(timestamp(x)));

export const listCourses = () =>
  transaction<Course[]>('courses', 'readonly', s => s.getAll());

export const saveSession = (x: SavedSession) =>
  transaction('sessions', 'readwrite', s => s.put(timestamp(x)));

export const listSessions = () =>
  transaction<SavedSession[]>('sessions', 'readonly', s => s.getAll());

export const saveLine = (x: SavedLine) =>
  transaction('lines', 'readwrite', s => s.put(timestamp(x)));

export const listLines = (id: string) =>
  transaction<SavedLine[]>('lines', 'readonly', s => s.index('sessionId').getAll(id));
export const saveAudio = (x: AudioChunk) => transaction('audio', 'readwrite', s => s.put(x));
