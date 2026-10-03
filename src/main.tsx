import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CaptionEngine, TranslationQueue, type CaptionLine, type TranslationTask } from './caption-engine';
import { download } from './audio';
import { listCourses, listLines, listSessions, saveAudio, saveCourse, saveLine, saveSession, type Course, type SavedSession } from './db';
import {
  listSessionStates,
  moveSessionToTrash,
  permanentlyDeleteLocalSession,
  restoreSessionFromTrash,
} from './db';
import { RealtimeStream, type StreamStatus } from './realtime';
import {
  acquireMicrophoneStream,
  getMicrophonePermissionState,
  watchMicrophonePermission,
  type MicrophonePermissionState,
} from './microphone-permission';
import { getSyncKey, hasSyncKey, setSyncKey, syncAllHistory, syncIndex, syncSessionLines } from './sync';
import { HomeTab, type HomeTabKey } from './ui/HomeTab';
import { HistoryScreen } from './ui/HistoryScreen';
import { InterpreterScreen } from './ui/InterpreterScreen';
import { SplashScreen } from './ui/SplashScreen';
import './style.css';
import './ui/ui.css';

function clock(seconds: number) { const n = Math.floor(seconds); return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; }
function filename(value: string) { return value.replace(/[^\p{L}\p{N}-]+/gu, '-'); }
const labels: Record<StreamStatus, string> = { connecting: '正在连接', listening: '正在听', recovering: '连接恢复中…', interrupted: '网络暂时中断，正在恢复' };

const HEARU_SPLASH_CACHE = 'hearu-splash-cache';
const HEARU_SPLASH_TTL = 6 * 60 * 60 * 1000;

function shouldShowSplash() {
  try {
    const last = Number(
      localStorage.getItem(HEARU_SPLASH_CACHE) || 0,
    );

    return (
      !last ||
      Date.now() - last > HEARU_SPLASH_TTL
    );
  } catch {
    return true;
  }
}
async function translate(tasks: TranslationTask[], source: 'it' | 'zh', vocabulary: string[]) {
  const response = await fetch('/api/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts: tasks.map(task => task.text), source, vocabulary }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '翻译暂时中断');
  return result.texts as string[];
}
function App() {
  const [mode, setMode] = useState<'classroom' | 'conversation'>('classroom');
  const [view, setView] = useState<'live' | 'history'>('live');
  const [courseName, setCourseName] = useState('临时课堂');
  const [vocabText, setVocabText] = useState('');
  const [courses, setCourses] = useState<Course[]>([]);
  const [language, setLanguage] = useState<'it' | 'zh'>('it');
  const [status, setStatus] = useState('准备就绪');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [microphonePermission, setMicrophonePermission] =
    useState<MicrophonePermissionState>('unsupported');
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [lines, setLines] = useState<CaptionLine[]>([]);
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [trashedSessionIds, setTrashedSessionIds] =
    useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [follow, setFollow] = useState(true);
  const [queueLength, setQueueLength] = useState(0);
  const [syncStatus, setSyncStatus] = useState(hasSyncKey() ? '同步已启用' : '同步未启用');
  const [syncKeyInput, setSyncKeyInput] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(hasSyncKey());
  const [showSplash, setShowSplash] = useState(shouldShowSplash);
  const engineRef = useRef<CaptionEngine | null>(null);
  const queueRef = useRef<TranslationQueue | null>(null);
  const streamRef = useRef<RealtimeStream | null>(null);
  const sessionRef = useRef<SavedSession | null>(null);
  const writeRef = useRef<Promise<unknown>>(Promise.resolve());
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScroll = useRef(false);
  const lastPersist = useRef(0);
  const persisted = useRef(new Map<string, string>());
  const liveLines = useRef<CaptionLine[]>([]);
  const [visibleCount, setVisibleCount] = useState(180);
  const refresh = async () => {
    const [
      nextSessions,
      nextCourses,
      states,
    ] = await Promise.all([
      listSessions(),
      listCourses(),
      listSessionStates(),
    ]);

    setSessions(
      nextSessions.sort(
        (a, b) =>
          b.startedAt.localeCompare(
            a.startedAt,
          ),
      ),
    );

    setCourses(nextCourses);

    setTrashedSessionIds(
      new Set(
        states
          .filter(
            state =>
              Boolean(
                state.trashedAt,
              ),
          )
          .map(
            state =>
              state.sessionId,
          ),
      ),
    );
  };

  async function refreshWithSync() {
    await refresh();

    if (!hasSyncKey()) {
      setSyncStatus('同步未启用');
      return;
    }

    setSyncStatus('正在同步…');

    try {
      const synced = await syncIndex();

      setSessions(
        [...synced.sessions].sort(
          (a, b) => b.startedAt.localeCompare(a.startedAt),
        ),
      );

      setCourses(synced.courses);
      setSyncStatus('已同步');
    } catch {
      setSyncStatus('当前离线，显示本机记录');
    }
  }

  async function syncEverything() {
    if (!hasSyncKey()) {
      setSyncStatus('同步未启用');
      return;
    }

    setSyncStatus('正在同步全部历史…');

    try {
      const synced = await syncAllHistory();

      setSessions(
        [...synced.sessions].sort(
          (a, b) => b.startedAt.localeCompare(a.startedAt),
        ),
      );

      setCourses(synced.courses);
      setSyncStatus('同步完成');
    } catch {
      setSyncStatus('同步暂时中断');
    }
  }

  async function saveSyncConfiguration() {
    const key = syncKeyInput.trim();

    if (!key) {
      if (hasSyncKey()) {
        await syncEverything();
      } else {
        setSyncStatus('请输入 Sync Key');
      }

      return;
    }

    const previousKey = getSyncKey();

    setSyncKey(key);
    setSyncStatus('正在验证并同步…');

    try {
      const synced = await syncAllHistory();

      setSessions(
        [...synced.sessions].sort(
          (a, b) => b.startedAt.localeCompare(a.startedAt),
        ),
      );

      setCourses(synced.courses);
      setSyncEnabled(true);
      setSyncKeyInput('');
      setSyncStatus('同步完成');
    } catch (cause) {
      setSyncKey(previousKey);
      setSyncEnabled(Boolean(previousKey));
      setSyncStatus(
        cause instanceof Error
          ? cause.message
          : '同步配置失败',
      );
    }
  }

  function disableSync() {
    setSyncKey('');
    setSyncKeyInput('');
    setSyncEnabled(false);
    setSyncStatus('同步未启用');
  }

  async function trashSession(
    id: string,
  ) {
    await moveSessionToTrash(id);

    setTrashedSessionIds(
      current => {
        const next =
          new Set(current);

        next.add(id);

        return next;
      },
    );

    if (selected === id) {
      setSelected(null);
      setLines([]);
    }
  }

  async function restoreTrashedSession(
    id: string,
  ) {
    await restoreSessionFromTrash(id);

    setTrashedSessionIds(
      current => {
        const next =
          new Set(current);

        next.delete(id);

        return next;
      },
    );
  }

  async function emptyTrash() {
    const ids =
      [...trashedSessionIds];

    if (!ids.length) {
      return;
    }

    try {
      /*
       * 每条记录：
       * - 删除本地 session
       * - 删除字幕
       * - 删除录音
       * - 删除回收站状态
       * - 写入 pending tombstone
       */
      await Promise.all(
        ids.map(id =>
          permanentlyDeleteLocalSession(
            id,
          ),
        ),
      );

      const deleted =
        new Set(ids);

      setSessions(previous =>
        previous.filter(
          session =>
            !deleted.has(
              session.id,
            ),
        ),
      );

      setTrashedSessionIds(
        new Set(),
      );

      if (
        selected &&
        deleted.has(selected)
      ) {
        setSelected(null);
        setLines([]);
      }

      if (hasSyncKey()) {
        setSyncStatus(
          '正在永久删除…',
        );

        try {
          /*
           * syncIndex 首先会上传 pending tombstones，
           * 然后重新 pull 云端状态。
           */
          const synced =
            await syncIndex();

          setSessions(
            [...synced.sessions].sort(
              (a, b) =>
                b.startedAt.localeCompare(
                  a.startedAt,
                ),
            ),
          );

          setCourses(
            synced.courses,
          );

          setSyncStatus(
            '已同步',
          );
        } catch {
          /*
           * 本机已经永久删除。
           * pending tombstone 仍保存在 IndexedDB，
           * 下次联网同步会继续处理。
           */
          setSyncStatus(
            '本机已删除，联网后继续同步删除',
          );
        }
      }
    } catch {
      setError(
        '清空回收站失败',
      );

      await refresh();
    }
  }

  async function renameSession(
    id: string,
    title: string,
  ) {
    const current =
      sessions.find(
        session =>
          session.id === id,
      );

    if (!current) return;

    const nextTitle =
      title.trim().slice(0, 80);

    const updated: SavedSession = {
      ...current,
      title:
        nextTitle || undefined,

      /*
       * loaded sessions already contain updatedAt,
       * so this edit must explicitly advance it.
       */
      updatedAt: Date.now(),
    };

    try {
      await saveSession(updated);

      setSessions(previous =>
        previous.map(session =>
          session.id === id
            ? updated
            : session,
        ),
      );

      if (
        sessionRef.current?.id === id
      ) {
        sessionRef.current =
          updated;
      }

      if (hasSyncKey()) {
        setSyncStatus(
          '正在同步标题…',
        );

        try {
          const synced =
            await syncIndex();

          setSessions(
            [...synced.sessions].sort(
              (a, b) =>
                b.startedAt.localeCompare(
                  a.startedAt,
                ),
            ),
          );

          setCourses(
            synced.courses,
          );

          setSyncStatus('已同步');
        } catch {
          setSyncStatus(
            '标题已保存在本机，云端稍后同步',
          );
        }
      }
    } catch {
      setError(
        '标题保存失败',
      );
    }
  }


  async function generateAutomaticTitle(
    session: SavedSession,
    transcriptLines: CaptionLine[],
  ) {
    const transcript =
      transcriptLines
        .map(line => {
          const source =
            (
              line.stable +
              line.active
            ).trim();

          const translation =
            line.translation.trim();

          /*
           * 意大利语课堂优先使用已经翻译好的中文，
           * 没有译文时再退回原文。
           */
          return (
            translation ||
            source
          );
        })
        .filter(Boolean)
        .join('\n')
        .slice(0, 8000);

    if (
      transcript.length < 12
    ) {
      return;
    }

    try {
      const response =
        await fetch(
          '/api/title',
          {
            method: 'POST',
            headers: {
              'content-type':
                'application/json',
            },
            body: JSON.stringify({
              transcript,
              course:
                session.course,
            }),
          },
        );

      const result =
        await response
          .json()
          .catch(() => ({}));

      if (
        !response.ok ||
        typeof result.title !==
          'string'
      ) {
        return;
      }

      const title =
        result.title
          .trim()
          .slice(0, 80);

      if (!title) return;

      /*
       * AI 返回期间用户可能已经手动改名。
       * 再从 IndexedDB 读取一次，确保人工标题永远优先。
       */
      const latest =
        (
          await listSessions()
        ).find(
          item =>
            item.id ===
            session.id,
        );

      if (
        !latest ||
        latest.title?.trim()
      ) {
        return;
      }

      const updated:
        SavedSession = {
          ...latest,
          title,
          updatedAt:
            Date.now(),
        };

      await saveSession(
        updated,
      );

      if (
        sessionRef.current?.id ===
        updated.id
      ) {
        sessionRef.current =
          updated;
      }

      setSessions(previous =>
        previous.map(item =>
          item.id ===
          updated.id
            ? updated
            : item,
        ),
      );

      /*
       * title 是 session metadata，
       * 只需同步 index，
       * 不重新上传整份逐字稿。
       */
      if (hasSyncKey()) {
        try {
          const synced =
            await syncIndex();

          setSessions(
            [...synced.sessions].sort(
              (a, b) =>
                b.startedAt.localeCompare(
                  a.startedAt,
                ),
            ),
          );

          setCourses(
            synced.courses,
          );
        } catch {
          /*
           * 自动标题是非关键增强；
           * 本地已经保存，稍后正常同步即可。
           */
        }
      }
    } catch {
      /*
       * 自动标题失败不影响课堂保存。
       */
    }
  }

  useEffect(() => {
    refreshWithSync().catch(() => setError('浏览器存储暂时不可用'));
    fetch('/api/status').then(r => r.json()).then(x => setConfigured(Boolean(x.configured))).catch(() => setConfigured(false));
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
  useEffect(() => {
    let cleanup = () => {};
    let cancelled = false;

    void watchMicrophonePermission(
      state => {
        if (!cancelled) {
          setMicrophonePermission(state);
        }
      },
    ).then(stopWatching => {
      if (cancelled) {
        stopWatching();
      } else {
        cleanup = stopWatching;
      }
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  useEffect(() => {
    if (!showSplash) return;

    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(
          HEARU_SPLASH_CACHE,
          String(Date.now()),
        );
      } catch {}

      setShowSplash(false);
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [showSplash]);

  useEffect(() => {
    if (!recording) return;
    const interval = window.setInterval(() => {
      const now = Date.now(); setElapsed(streamRef.current?.elapsed || 0);
      const tasks = engineRef.current?.translationTasks(now) || [];
      if (tasks.length) queueRef.current?.add(tasks);
      setQueueLength(queueRef.current?.length || 0);
      if (now - lastPersist.current > 1500) { persistLines(); lastPersist.current = now; }
    }, 500);
    return () => clearInterval(interval);
  }, [recording]);
  useEffect(() => { if (follow && view === 'live') scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' }); }, [lines, follow, view]);
  function persistLines() {
    const session = sessionRef.current;
    if (!session) return;
    for (const line of liveLines.current) {
      const signature = JSON.stringify(line);
      if (persisted.current.get(line.id) === signature) continue;
      persisted.current.set(line.id, signature);
      writeRef.current = writeRef.current.then(() => saveLine({ ...line, sessionId: session.id })).catch(() => { persisted.current.delete(line.id); setError('字幕保存中断，请导出当前内容'); });
    }
    session.duration = streamRef.current?.elapsed || session.duration;
    writeRef.current = writeRef.current.then(() => saveSession({ ...session })).catch(() => setError('课堂记录保存中断'));
  }
  function setModeTo(value: 'classroom' | 'conversation') { setMode(value); setView('live'); setLanguage('it'); setLines([]); setError(''); }
  async function start() {
    if (configured !== true) {
      setError('在线服务正在检查配置');
      return;
    }

    if (microphonePermission === 'denied') {
      setError(
        '麦克风权限已关闭，请在系统设置中允许 HearU 使用麦克风',
      );
      return;
    }

    setError('');
    setLines([]);
    liveLines.current = [];
    persisted.current.clear();
    setVisibleCount(180);
    setFollow(true);
    setElapsed(0);

    const vocabulary = vocabText
      .split(/[\n,，;；]/)
      .map(x => x.trim())
      .filter(Boolean)
      .slice(0, 60);

    const name =
      courseName.trim() ||
      '临时课堂';

    const session: SavedSession = {
      id: crypto.randomUUID(),
      course:
        mode === 'classroom'
          ? name
          : '日常对话',
      mode,
      language,
      startedAt:
        new Date().toISOString(),
      duration: 0,
      vocabulary,
      chunks: 0,
    };

    /*
     * 这两件事必须直接发生在用户点击链路中：
     *
     * 1. 请求麦克风
     * 2. RealtimeStream.start() 解锁 AudioContext
     *
     * 这里故意不在它们之前 await 数据库操作。
     */
    const microphonePromise =
      acquireMicrophoneStream();

    let stream:
      RealtimeStream | null = null;

    sessionRef.current = session;

    const engine =
      new CaptionEngine(updated => {
        liveLines.current = updated;
        setLines(updated);
      });

    engineRef.current = engine;

    queueRef.current =
      new TranslationQueue(
        tasks =>
          translate(
            tasks,
            language,
            vocabulary,
          ),
        (id, text) => {
          engine.attachTranslation(
            id,
            text,
          );

          persistLines();
        },
        message =>
          setError(
            `翻译追赶中：${message}`,
          ),
      );

    stream = new RealtimeStream(
      language,
      vocabulary,
      {
        status: value => {
          setStatus(labels[value]);

          if (
            value === 'listening'
          ) {
            setError('');
          }
        },

        partial: (
          id,
          text,
          at,
        ) => {
          engine.partial(
            id,
            text,
            at,
          );

          setError('');
        },

        complete: (
          id,
          text,
          at,
        ) => {
          engine.complete(
            id,
            text,
            at,
          );

          queueRef.current?.add(
            engine.translationTasks(
              Date.now(),
            ),
          );
        },

        committed: (
          id,
          at,
        ) =>
          engine.committed(
            id,
            at,
          ),

        level: setLevel,

        error: message =>
          setError(message),
      },
      (blob, format) => {
        const index =
          session.chunks++;

        return saveAudio({
          key:
            `${session.id}|${index}`,
          sessionId:
            session.id,
          index,
          blob,
          format,
        }).then(() =>
          saveSession({
            ...session,
          }),
        );
      },
    );

    streamRef.current = stream;

    /*
     * 立即启动。RealtimeStream 内部此时会：
     * - 解锁 AudioContext
     * - 等待上面的同一个 microphonePromise
     * - 并行预取 token / 建立 WebSocket
     */
    const streamStart =
      stream.start(
        microphonePromise,
      );

    try {
      /*
       * 数据库存储和课程保存与音频启动并行，
       * 不再阻塞麦克风和识别连接。
       */
      const storageTasks:
        Promise<unknown>[] = [
          saveSession(session),
      ];

      if (
        mode === 'classroom' &&
        name !== '临时课堂'
      ) {
        const course = {
          id:
            name.toLocaleLowerCase(),
          name,
          vocabulary,
        };

        storageTasks.push(
          saveCourse(course).then(
            () => {
              setCourses(old => [
                ...old.filter(
                  x =>
                    x.id !==
                    course.id,
                ),
                course,
              ]);
            },
          ),
        );
      }

      await Promise.all([
        streamStart,
        ...storageTasks,
      ]);

      setMicrophonePermission(
        'granted',
      );

      setRecording(true);
      setView('live');
    } catch (cause) {
      await stream.stop().catch(
        () => {},
      );

      streamRef.current = null;

      session.endedAt =
        new Date().toISOString();

      await saveSession(
        session,
      ).catch(() => {});

      const latestPermission =
        await getMicrophonePermissionState();

      setMicrophonePermission(
        latestPermission,
      );

      setError(
        cause instanceof Error
          ? cause.message
          : '麦克风无法启动',
      );

      setStatus('准备就绪');
    }
  }

  async function stop() {
    const stream = streamRef.current;
    if (!stream) return;
    setStatus('正在保存课堂…');
    await stream.stop();
    persistLines(); await writeRef.current;
    const session = sessionRef.current;
    if (session) { session.endedAt = new Date().toISOString(); session.duration = stream.elapsed; await saveSession({ ...session }); }
    streamRef.current = null;
    setRecording(false);
    setLevel(0);
    setStatus('课堂已保存');

    const completedLines =
      [...liveLines.current];

    await refresh();

    if (session) {
      void generateAutomaticTitle(
        session,
        completedLines,
      );
    }

    if (hasSyncKey()) {
      void syncEverything();
    }
  }

  async function openSession(id: string) {
    setSelected(id);
    setView('history');

    const local = (await listLines(id))
      .sort((a, b) => a.order - b.order);

    setLines(local);

    if (!hasSyncKey()) return;

    setSyncStatus('正在同步该课堂…');

    try {
      const merged = await syncSessionLines(id);
      setLines(merged);
      setSyncStatus('已同步');
    } catch {
      setSyncStatus('当前离线，显示本机记录');
    }
  }
  function exportText() {
    const session = view === 'live' ? sessionRef.current : sessions.find(x => x.id === selected);
    const text = lines.map(line => `[${clock(line.start)}] ${line.stable + line.active}\n${line.translation}`).join('\n\n');
    download(new Blob([`${session?.course || '课堂'} · ${session?.startedAt || ''}\n\n${text}`], { type: 'text/plain;charset=utf-8' }), `${filename(session?.course || '字幕')}-${filename(session?.startedAt || '当前')}.txt`);
  }
  const activeLine = [...lines]
    .reverse()
    .find(
      line =>
        !line.locked &&
        (line.stable || line.active),
    );

  const interpreterLines = lines
    .filter(
      line =>
        line.stable ||
        line.active,
    )
    .slice(-visibleCount)
    .map(line => ({
      id: line.id,
      source:
        line.stable +
        line.active,
      translation:
        line.translation,
    }));

  const activeTab: HomeTabKey =
    view === 'history'
      ? 'history'
      : mode === 'conversation'
        ? 'consecutive'
        : 'interpreter';

  function changeTab(
    tab: HomeTabKey,
  ) {
    if (recording) return;

    if (tab === 'interpreter') {
      setModeTo('classroom');
      return;
    }

    if (tab === 'consecutive') {
      setModeTo('conversation');
      return;
    }

    setSelected(null);
    setView('history');
    void refreshWithSync();
  }

  return (
    <div className="app-ui-shell">
      <SplashScreen
        visible={showSplash}
      />

      <div className="app-ui-content">
        {view === 'live' &&
          mode === 'classroom' && (
            <InterpreterScreen
              language={language}
              recording={recording}
              configured={
                configured === true
              }
              listening={
                recording &&
                status === '正在听'
              }
              level={level}
              lines={interpreterLines}
              activeLineId={
                activeLine?.id
              }
              follow={follow}
              error={
                error ||
                (configured === false
                  ? '在线服务尚未配置'
                  : '')
              }
              scrollRef={scrollRef}
              onLanguageChange={
                setLanguage
              }
              onStart={() =>
                void start()
              }
              onStop={() =>
                void stop()
              }
              onReturnLive={() => {
                setFollow(true);

                scrollRef.current?.scrollTo(
                  {
                    top:
                      scrollRef
                        .current
                        .scrollHeight,
                    behavior:
                      'smooth',
                  },
                );
              }}
              onScrollStart={() => {
                userScroll.current =
                  true;
              }}
              onScroll={element => {
                if (
                  !userScroll.current
                ) {
                  return;
                }

                if (
                  element.scrollTop <
                  80
                ) {
                  setVisibleCount(
                    count =>
                      count + 180,
                  );
                }

                const distance =
                  element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight;

                if (distance > 90) {
                  setFollow(false);
                }

                userScroll.current =
                  false;
              }}
            />
          )}

        {view === 'live' &&
          mode === 'conversation' && (
            <section className="consecutive-placeholder">
              <span>交传模式</span>
              <strong>
                即将开放
              </strong>
            </section>
          )}

        {view === 'history' && (
          <HistoryScreen
            sessions={sessions}
            selectedId={selected}
            lines={lines}
            trashedIds={trashedSessionIds}
            syncStatus={syncStatus}
            syncKeyInput={syncKeyInput}
            syncEnabled={syncEnabled}
            onSyncKeyChange={setSyncKeyInput}
            onSync={() =>
              void saveSyncConfiguration()
            }
            onDisableSync={disableSync}
            onOpenSession={id =>
              void openSession(id)
            }
            onBack={() => {
              setSelected(null);
              setLines([]);
            }}
            onExport={exportText}
            onTrash={id =>
              void trashSession(id)
            }
            onRestore={id =>
              void restoreTrashedSession(
                id,
              )
            }
            onRename={(id, title) =>
              void renameSession(
                id,
                title,
              )
            }
            onEmptyTrash={
              emptyTrash
            }
          />
        )}
      </div>

      <HomeTab
        active={activeTab}
        disabled={recording}
        onChange={changeTab}
      />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
