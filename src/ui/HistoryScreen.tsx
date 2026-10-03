import {
  useRef,
  useState,
} from 'react';

import type {
  CaptionLine,
} from '../caption-engine';

import type {
  SavedSession,
} from '../db';

type HistoryScreenProps = {
  sessions: SavedSession[];
  selectedId: string | null;
  lines: CaptionLine[];

  trashedIds: Set<string>;

  syncStatus: string;
  syncKeyInput: string;
  syncEnabled: boolean;

  onSyncKeyChange: (
    value: string,
  ) => void;

  onSync: () => void;
  onDisableSync: () => void;

  onOpenSession: (
    id: string,
  ) => void;

  onBack: () => void;
  onExport: () => void;

  onTrash: (
    id: string,
  ) => void;

  onRestore: (
    id: string,
  ) => void;

  onRename: (
    id: string,
    title: string,
  ) => void;

  onEmptyTrash:
    () => Promise<void>;
};

const DELETE_REVEAL = 78;

function clock(
  seconds: number,
) {
  const n = Math.floor(seconds);

  return `${String(
    Math.floor(n / 60),
  ).padStart(2, '0')}:${String(
    n % 60,
  ).padStart(2, '0')}`;
}

function sessionTitle(
  session: SavedSession,
) {
  return (
    session.title?.trim() ||
    session.course ||
    '未命名记录'
  );
}

export function HistoryScreen({
  sessions,
  selectedId,
  lines,
  trashedIds,
  syncStatus,
  syncKeyInput,
  syncEnabled,
  onSyncKeyChange,
  onSync,
  onDisableSync,
  onOpenSession,
  onBack,
  onExport,
  onTrash,
  onRestore,
  onRename,
  onEmptyTrash,
}: HistoryScreenProps) {
  const [
    showSync,
    setShowSync,
  ] = useState(false);

  const [
    showTrash,
    setShowTrash,
  ] = useState(false);

  const [
    renameTarget,
    setRenameTarget,
  ] = useState<SavedSession | null>(
    null,
  );

  const [
    renameValue,
    setRenameValue,
  ] = useState('');

  const [
    swipeOpenId,
    setSwipeOpenId,
  ] = useState<string | null>(
    null,
  );

  const [
    swipeState,
    setSwipeState,
  ] = useState<{
    id: string;
    offset: number;
  } | null>(null);

  const [
    deletingId,
    setDeletingId,
  ] = useState<string | null>(
    null,
  );

  const [
    showEmptyConfirm,
    setShowEmptyConfirm,
  ] = useState(false);

  const [
    emptyingTrash,
    setEmptyingTrash,
  ] = useState(false);

  const renameTimer =
    useRef<number | null>(null);

  const longPressTriggered =
    useRef(false);

  const swipeMoved =
    useRef(false);

  const swipeGesture =
    useRef<{
      id: string;
      startX: number;
      startY: number;
      startOffset: number;
      axis:
        | 'x'
        | 'y'
        | null;
    } | null>(null);

  const selected =
    sessions.find(
      session =>
        session.id ===
        selectedId,
    );

  const activeSessions =
    sessions.filter(
      session =>
        !trashedIds.has(
          session.id,
        ),
    );

  const trashSessions =
    sessions.filter(
      session =>
        trashedIds.has(
          session.id,
        ),
    );

  function cancelRenameTimer() {
    if (
      renameTimer.current !==
      null
    ) {
      window.clearTimeout(
        renameTimer.current,
      );

      renameTimer.current =
        null;
    }
  }

  function beginRenamePress(
    session: SavedSession,
  ) {
    cancelRenameTimer();

    longPressTriggered.current =
      false;

    renameTimer.current =
      window.setTimeout(
        () => {
          longPressTriggered.current =
            true;

          setSwipeOpenId(null);
          setSwipeState(null);

          setRenameTarget(session);

          setRenameValue(
            sessionTitle(session),
          );

          renameTimer.current =
            null;
        },
        550,
      );
  }

  function submitRename() {
    if (!renameTarget) return;

    const value =
      renameValue
        .trim()
        .slice(0, 80);

    onRename(
      renameTarget.id,
      value,
    );

    setRenameTarget(null);
    setRenameValue('');
  }

  function beginSwipe(
    event: React.PointerEvent,
    id: string,
  ) {
    if (showTrash) return;

    if (
      swipeOpenId &&
      swipeOpenId !== id
    ) {
      setSwipeOpenId(null);
    }

    swipeMoved.current = false;

    swipeGesture.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      startOffset:
        swipeOpenId === id
          ? -DELETE_REVEAL
          : 0,
      axis: null,
    };
  }

  function moveSwipe(
    event: React.PointerEvent,
    id: string,
  ) {
    const gesture =
      swipeGesture.current;

    if (
      !gesture ||
      gesture.id !== id
    ) {
      return;
    }

    const dx =
      event.clientX -
      gesture.startX;

    const dy =
      event.clientY -
      gesture.startY;

    if (!gesture.axis) {
      if (
        Math.abs(dx) < 6 &&
        Math.abs(dy) < 6
      ) {
        return;
      }

      gesture.axis =
        Math.abs(dx) >
        Math.abs(dy)
          ? 'x'
          : 'y';
    }

    if (
      gesture.axis !== 'x'
    ) {
      return;
    }

    cancelRenameTimer();

    swipeMoved.current = true;

    event.preventDefault();

    const offset = Math.max(
      -DELETE_REVEAL,
      Math.min(
        0,
        gesture.startOffset +
          dx,
      ),
    );

    setSwipeState({
      id,
      offset,
    });
  }

  function finishSwipe(
    event: React.PointerEvent,
    id: string,
  ) {
    cancelRenameTimer();

    const gesture =
      swipeGesture.current;

    if (
      !gesture ||
      gesture.id !== id
    ) {
      return;
    }

    if (
      gesture.axis === 'x'
    ) {
      const dx =
        event.clientX -
        gesture.startX;

      const finalOffset =
        Math.max(
          -DELETE_REVEAL,
          Math.min(
            0,
            gesture.startOffset +
              dx,
          ),
        );

      if (
        finalOffset <
        -DELETE_REVEAL * 0.45
      ) {
        setSwipeOpenId(id);
      } else {
        setSwipeOpenId(null);
      }
    }

    setSwipeState(null);
    swipeGesture.current =
      null;
  }

  function deleteWithAnimation(
    id: string,
  ) {
    setDeletingId(id);
    setSwipeOpenId(null);
    setSwipeState(null);

    window.setTimeout(
      () => {
        onTrash(id);
        setDeletingId(null);
      },
      240,
    );
  }

  async function confirmEmptyTrash() {
    if (
      !trashSessions.length ||
      emptyingTrash
    ) {
      return;
    }

    setShowEmptyConfirm(false);
    setEmptyingTrash(true);

    /*
     * 先让列表完成离场动画，
     * 再真正删除数据。
     */
    await new Promise<void>(
      resolve =>
        window.setTimeout(
          resolve,
          220,
        ),
    );

    try {
      await onEmptyTrash();
    } finally {
      setEmptyingTrash(false);
    }
  }

  function offsetFor(
    id: string,
  ) {
    if (
      swipeState?.id === id
    ) {
      return swipeState.offset;
    }

    return swipeOpenId === id
      ? -DELETE_REVEAL
      : 0;
  }

  return (
    <section className="history-screen">
      <div
        className={`history-track ${
          selectedId
            ? 'show-detail'
            : ''
        }`}
      >
        {/* 历史列表 */}
        <div className="history-page">
          <header className="history-topbar history-list-topbar">
            {showTrash ? (
              <>
                <button
                  className="history-back"
                  type="button"
                  onClick={() =>
                    setShowTrash(false)
                  }
                >
                  ‹
                </button>

                <h1>回收站</h1>

                <button
                  className="history-empty-trash"
                  type="button"
                  disabled={
                    !trashSessions.length ||
                    emptyingTrash
                  }
                  onClick={() =>
                    setShowEmptyConfirm(
                      true,
                    )
                  }
                >
                  清空
                </button>
              </>
            ) : (
              <>
                <h1>历史记录</h1>

                <div className="history-top-actions">
                  <button
                    className={
                      showSync
                        ? 'history-sync-button active'
                        : 'history-sync-button'
                    }
                    type="button"
                    onClick={() =>
                      setShowSync(
                        value =>
                          !value,
                      )
                    }
                  >
                    同步
                  </button>

                  <button
                    className="history-trash-entry"
                    type="button"
                    onClick={() => {
                      setShowSync(false);
                      setSwipeOpenId(null);
                      setShowTrash(true);
                    }}
                  >
                    回收站
                  </button>
                </div>
              </>
            )}
          </header>

          <div className="history-list-area">
            {!showTrash &&
              showSync && (
                <div className="history-sync-panel">
                  <div className="history-sync-status">
                    {syncStatus}
                  </div>

                  <input
                    type="password"
                    autoComplete="off"
                    value={
                      syncKeyInput
                    }
                    onChange={
                      event =>
                        onSyncKeyChange(
                          event
                            .target
                            .value,
                        )
                    }
                    placeholder={
                      syncEnabled
                        ? '同步已配置'
                        : 'Sync Key'
                    }
                  />

                  <div className="history-sync-actions">
                    <button
                      type="button"
                      className="history-sync-primary"
                      onClick={onSync}
                    >
                      {syncEnabled &&
                      !syncKeyInput.trim()
                        ? '立即同步'
                        : '连接并同步'}
                    </button>

                    {syncEnabled && (
                      <button
                        type="button"
                        className="history-sync-secondary"
                        onClick={
                          onDisableSync
                        }
                      >
                        关闭同步
                      </button>
                    )}
                  </div>
                </div>
              )}

            <div
              className={`history-list-scroll ${
                showTrash &&
                emptyingTrash
                  ? 'is-emptying-trash'
                  : ''
              }`}
            >
              {(
                showTrash
                  ? trashSessions
                  : activeSessions
              ).length ? (
                <div className="history-list">
                  {(
                    showTrash
                      ? trashSessions
                      : activeSessions
                  ).map(
                    session => {
                      const offset =
                        offsetFor(
                          session.id,
                        );

                      return (
                        <div
                          className={`history-record-row ${
                            deletingId ===
                            session.id
                              ? 'is-deleting'
                              : ''
                          }`}
                          key={
                            session.id
                          }
                        >
                          {!showTrash && (
                            <button
                              className="history-delete-pill"
                              type="button"
                              onClick={() =>
                                deleteWithAnimation(
                                  session.id,
                                )
                              }
                            >
                              删除
                            </button>
                          )}

                          <button
                            className="history-record"
                            type="button"
                            style={
                              showTrash
                                ? undefined
                                : {
                                    transform:
                                      `translate3d(${offset}px, 0, 0)`,
                                  }
                            }
                            onPointerDown={
                              event =>
                                beginSwipe(
                                  event,
                                  session.id,
                                )
                            }
                            onPointerMove={
                              event =>
                                moveSwipe(
                                  event,
                                  session.id,
                                )
                            }
                            onPointerUp={
                              event =>
                                finishSwipe(
                                  event,
                                  session.id,
                                )
                            }
                            onPointerCancel={
                              event =>
                                finishSwipe(
                                  event,
                                  session.id,
                                )
                            }
                            onClick={() => {
                              if (
                                showTrash
                              ) {
                                return;
                              }

                              if (
                                longPressTriggered.current
                              ) {
                                longPressTriggered.current =
                                  false;
                                return;
                              }

                              if (
                                swipeMoved.current
                              ) {
                                swipeMoved.current =
                                  false;
                                return;
                              }

                              if (
                                swipeOpenId ===
                                session.id
                              ) {
                                setSwipeOpenId(
                                  null,
                                );
                                return;
                              }

                              onOpenSession(
                                session.id,
                              );
                            }}
                          >
                            <span className="history-record-copy">
                              <strong
                                className="history-record-title"
                                onPointerDown={() =>
                                  beginRenamePress(
                                    session,
                                  )
                                }
                                onContextMenu={event => {
                                  event.preventDefault();
                                  event.stopPropagation();

                                  setSwipeOpenId(
                                    null,
                                  );

                                  setRenameTarget(
                                    session,
                                  );

                                  setRenameValue(
                                    sessionTitle(
                                      session,
                                    ),
                                  );
                                }}
                              >
                                {sessionTitle(
                                  session,
                                )}
                              </strong>

                              <small>
                                {new Date(
                                  session.startedAt,
                                ).toLocaleString(
                                  'zh-CN',
                                )}
                              </small>
                            </span>

                            <span className="history-record-meta">
                              {clock(
                                session.duration,
                              )}

                              {!showTrash && (
                                <b>›</b>
                              )}
                            </span>
                          </button>

                          {showTrash && (
                            <button
                              className="history-record-action restore"
                              type="button"
                              onClick={() =>
                                onRestore(
                                  session.id,
                                )
                              }
                            >
                              恢复
                            </button>
                          )}
                        </div>
                      );
                    },
                  )}
                </div>
              ) : (
                <div className="history-empty">
                  {showTrash
                    ? '回收站为空'
                    : '暂无记录'}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 逐字稿 */}
        <div className="history-page">
          <header className="history-topbar">
            <button
              className="history-back"
              type="button"
              onClick={onBack}
            >
              ‹
            </button>

            <div className="history-detail-title">
              <strong>
                {selected
                  ? sessionTitle(
                      selected,
                    )
                  : '逐字稿'}
              </strong>

              {selected && (
                <small>
                  {new Date(
                    selected.startedAt,
                  ).toLocaleString(
                    'zh-CN',
                  )}
                </small>
              )}
            </div>

            <button
              className="history-export"
              type="button"
              onClick={onExport}
            >
              导出
            </button>
          </header>

          <div className="history-transcript-scroll">
            {lines.length ? (
              <div className="history-transcript">
                {lines.map(
                  line => (
                    <article
                      className="history-line"
                      key={
                        line.id
                      }
                    >
                      <p className="history-source">
                        {line.stable +
                          line.active}
                      </p>

                      {line.translation && (
                        <p className="history-translation">
                          {
                            line.translation
                          }
                        </p>
                      )}
                    </article>
                  ),
                )}
              </div>
            ) : (
              <div className="history-empty">
                暂无逐字稿
              </div>
            )}
          </div>
        </div>
      </div>

      {showEmptyConfirm && (
        <div
          className="trash-confirm-overlay"
          onPointerDown={event => {
            if (
              event.target ===
              event.currentTarget
            ) {
              setShowEmptyConfirm(
                false,
              );
            }
          }}
        >
          <div className="trash-confirm-sheet">
            <strong>
              清空回收站？
            </strong>

            <p>
              这些记录将从本机和云端永久删除，并在其他设备同步后移除。此操作无法恢复。
            </p>

            <div className="trash-confirm-actions">
              <button
                type="button"
                className="trash-confirm-cancel"
                onClick={() =>
                  setShowEmptyConfirm(
                    false,
                  )
                }
              >
                取消
              </button>

              <button
                type="button"
                className="trash-confirm-delete"
                onClick={() =>
                  void confirmEmptyTrash()
                }
              >
                永久删除
              </button>
            </div>
          </div>
        </div>
      )}

      {renameTarget && (
        <div
          className="rename-overlay"
          onPointerDown={event => {
            if (
              event.target ===
              event.currentTarget
            ) {
              setRenameTarget(null);
              setRenameValue('');
            }
          }}
        >
          <form
            className="rename-sheet"
            onSubmit={event => {
              event.preventDefault();
              submitRename();
            }}
          >
            <div className="rename-sheet-title">
              重命名
            </div>

            <input
              autoFocus
              value={renameValue}
              maxLength={80}
              onChange={event =>
                setRenameValue(
                  event.target.value,
                )
              }
            />

            <div className="rename-sheet-actions">
              <button
                type="button"
                className="rename-cancel"
                onClick={() => {
                  setRenameTarget(null);
                  setRenameValue('');
                }}
              >
                取消
              </button>

              <button
                type="submit"
                className="rename-save"
              >
                保存
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
