import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CaptionEngine, TranslationQueue, type CaptionLine, type TranslationTask } from './caption-engine';
import { download } from './audio';
import { listCourses, listLines, listSessions, saveAudio, saveCourse, saveLine, saveSession, type Course, type SavedSession } from './db';
import { RealtimeStream, type StreamStatus } from './realtime';
import { getSyncKey, hasSyncKey, setSyncKey, syncAllHistory, syncIndex, syncSessionLines } from './sync';
import './style.css';

function clock(seconds: number) { const n = Math.floor(seconds); return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; }
function filename(value: string) { return value.replace(/[^\p{L}\p{N}-]+/gu, '-'); }
const labels: Record<StreamStatus, string> = { connecting: '正在连接', listening: '正在听', recovering: '连接恢复中…', interrupted: '网络暂时中断，正在恢复' };
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
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [lines, setLines] = useState<CaptionLine[]>([]);
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [follow, setFollow] = useState(true);
  const [queueLength, setQueueLength] = useState(0);
  const [syncStatus, setSyncStatus] = useState(hasSyncKey() ? '同步已启用' : '同步未启用');
  const [syncKeyInput, setSyncKeyInput] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(hasSyncKey());
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
    setSessions((await listSessions()).sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
    setCourses(await listCourses());
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

  useEffect(() => {
    refreshWithSync().catch(() => setError('浏览器存储暂时不可用'));
    fetch('/api/status').then(r => r.json()).then(x => setConfigured(Boolean(x.configured))).catch(() => setConfigured(false));
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
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
    if (configured !== true) { setError('在线服务正在检查配置'); return; }
    setError(''); setLines([]); liveLines.current = []; persisted.current.clear(); setVisibleCount(180); setFollow(true); setElapsed(0);
    const vocabulary = vocabText.split(/[\n,，;；]/).map(x => x.trim()).filter(Boolean).slice(0, 60);
    const name = courseName.trim() || '临时课堂';
    const session: SavedSession = { id: crypto.randomUUID(), course: mode === 'classroom' ? name : '日常对话', mode, language, startedAt: new Date().toISOString(), duration: 0, vocabulary, chunks: 0 };
    let stream: RealtimeStream | null = null;
    try {
      await saveSession(session); sessionRef.current = session;
      if (mode === 'classroom' && name !== '临时课堂') { const course = { id: name.toLocaleLowerCase(), name, vocabulary }; await saveCourse(course); setCourses(old => [...old.filter(x => x.id !== course.id), course]); }
      const engine = new CaptionEngine(updated => { liveLines.current = updated; setLines(updated); }); engineRef.current = engine;
      queueRef.current = new TranslationQueue(tasks => translate(tasks, language, vocabulary), (id, text) => { engine.attachTranslation(id, text); persistLines(); }, message => setError(`翻译追赶中：${message}`));
      stream = new RealtimeStream(language, vocabulary, {
        status: value => { setStatus(labels[value]); if (value === 'listening') setError(''); },
        partial: (id, text, at) => { engine.partial(id, text, at); setError(''); },
        complete: (id, text, at) => { engine.complete(id, text, at); queueRef.current?.add(engine.translationTasks(Date.now())); },
        committed: (id, at) => engine.committed(id, at),
        level: setLevel,
        error: message => setError(message),
      }, (blob, format) => {
        const index = session.chunks++;
        return saveAudio({ key: `${session.id}|${index}`, sessionId: session.id, index, blob, format }).then(() => saveSession({ ...session }));
      });
      streamRef.current = stream;
      await stream.start();
      setRecording(true); setView('live');
    } catch (cause) {
      await stream?.stop(); streamRef.current = null; session.endedAt = new Date().toISOString(); await saveSession(session).catch(() => {});
      setError(cause instanceof Error ? cause.message : '麦克风无法启动'); setStatus('准备就绪');
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
    streamRef.current = null; setRecording(false); setLevel(0); setStatus('课堂已保存');
    await refresh();

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
  const current = view === 'live' && recording;
  const activeLine = [...lines].reverse().find(x => !x.locked && (x.stable || x.active));
  return <div className="app"><header className="top"><div className="brand"><span className="brand-mark">⌁</span><div><strong>听见</strong><small>意大利语 · 中文实时字幕</small></div></div><nav><button className={mode === 'classroom' && view === 'live' ? 'active' : ''} disabled={recording} onClick={() => setModeTo('classroom')}>Classroom</button><button className={mode === 'conversation' && view === 'live' ? 'active' : ''} disabled={recording} onClick={() => setModeTo('conversation')}>Conversation</button><button className={view === 'history' ? 'active' : ''} disabled={recording} onClick={() => { setView('history'); void refreshWithSync(); }}>课堂记录</button></nav></header>
  <main>{view === 'live' ? <><section className="intro"><div className="eyebrow">{mode === 'classroom' ? 'CLASSROOM · IT → 中文' : 'CONVERSATION · 双向短时对话'}</div><h1>{mode === 'classroom' ? '跟上每一句。' : '听懂眼前的对话。'}</h1><p>原文随讲话持续增长，中文在下方跟随。已读字幕保持顺序。</p></section>
    {mode === 'classroom' ? <section className="setup"><label>课程名称<input value={courseName} disabled={recording} onChange={e => { const name = e.target.value; setCourseName(name); const match = courses.find(x => x.name === name); if (match) setVocabText(match.vocabulary.join('\n')); }} list="courses" placeholder="Archeologia Romana"/><datalist id="courses">{courses.map(c => <option key={c.id} value={c.name}/>)}</datalist></label><label>课程术语 <small>每行一个</small><textarea value={vocabText} disabled={recording} onChange={e => setVocabText(e.target.value)} placeholder="Augusto\nPalatino\nEtruschi" rows={2}/></label></section> : <div className="direction"><button className={language === 'it' ? 'chosen' : ''} disabled={recording} onClick={() => setLanguage('it')}>意大利语 → 中文</button><button className={language === 'zh' ? 'chosen' : ''} disabled={recording} onClick={() => setLanguage('zh')}>中文 → 意大利语</button></div>}
    <section className="workspace"><div className="workspace-head"><div className="workspace-title"><span className={`pulse ${recording ? 'on' : ''}`}/><span>{status}</span></div><span className="timer">{clock(elapsed)}</span></div>
      <div className="caption-scroll" ref={scrollRef} onWheel={() => { userScroll.current = true; }} onTouchStart={() => { userScroll.current = true; }} onScroll={e => { if (userScroll.current) { if (e.currentTarget.scrollTop < 80) setVisibleCount(n => n + 180); if (e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight > 90) setFollow(false); } userScroll.current = false; }} aria-live="polite">
        {lines.length ? <div className="caption-list">{lines.filter(x => x.stable || x.active).slice(-visibleCount).map(line => <article className={`caption ${line.id === activeLine?.id ? 'current' : ''}`} key={line.id}><time>{clock(line.start)}</time><p lang={language}><span>{line.stable}</span><span className="active-tail">{line.active}</span></p>{line.translation && <p className="translation" lang={language === 'it' ? 'zh' : 'it'}>{line.translation}</p>}</article>)}</div> : <div className="empty"><span>〰</span><h2>字幕会出现在这里</h2><p>点击开始，允许麦克风。讲到的词会立即接入原文。</p></div>}
      </div>{!follow && <button className="return-live" onClick={() => { setFollow(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}>回到实时字幕 ↓</button>}
      <div className="controls"><div className="meter" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ height: `${Math.max(4, Math.min(27, level * 34 * (0.5 + ((i * 7) % 9) / 10)))}px` }}/>)}</div><span className="queue">{queueLength ? `翻译队列 ${queueLength}` : '翻译实时跟随'}</span>{recording ? <button className="stop" onClick={stop}>结束并保存</button> : <button className="primary" disabled={configured !== true} onClick={start}>开始{mode === 'classroom' ? '听课' : '录音'}</button>}</div></section>
    {configured === false && <div className="notice" role="status">在线服务密钥待配置。配置完成后即可开始流式识别。</div>}{error && <div className="error" role="alert">{error}</div>}<p className="note">课堂记录与音频片段存储在当前设备。保持页面在前台，以便持续采音。</p>
  </> : <><section className="intro"><div className="eyebrow">HISTORY</div><h1>课堂记录</h1><p>双语字幕保存在本机；启用同步后，可在你的设备之间共享课堂记录。</p></section><section className="setup sync-setup"><label>跨设备同步 <small>{syncStatus}</small><input type="password" autoComplete="off" value={syncKeyInput} onChange={e => setSyncKeyInput(e.target.value)} placeholder={syncEnabled ? '同步已配置；输入新 Key 可替换' : '粘贴 HearU Sync Key'}/></label><div className="sync-actions"><button className="primary" onClick={() => void saveSyncConfiguration()}>{syncEnabled && !syncKeyInput.trim() ? '立即同步' : '保存并同步'}</button>{syncEnabled && <button className="sync-secondary" onClick={disableSync}>关闭同步</button>}</div></section><section className="history"><div className="sessions">{sessions.length ? sessions.map(s => <button className={selected === s.id ? 'selected' : ''} key={s.id} onClick={() => openSession(s.id)}><strong>{s.course}</strong><small>{new Date(s.startedAt).toLocaleString('zh-CN')} · {clock(s.duration)}</small></button>) : <p>还没有课堂记录。</p>}</div><div className="history-detail">{selected ? <><div className="detail-heading"><h2>双语逐字稿</h2><button onClick={exportText}>下载 .txt</button></div>{lines.map(line => <article className="caption" key={line.id}><time>{clock(line.start)}</time><p lang="it">{line.stable + line.active}</p><p className="translation">{line.translation}</p></article>)}</> : <p>选择一条记录查看字幕。</p>}</div></section>{error && <div className="error">{error}</div>}</>}</main><footer>听见 · 课堂实时同传</footer></div>;
}
createRoot(document.getElementById('root')!).render(<App />);
