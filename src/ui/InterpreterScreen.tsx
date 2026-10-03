import type { RefObject } from 'react';

export type InterpreterLanguage = 'it' | 'zh';

export type InterpreterLine = {
  id: string;
  source: string;
  translation: string;
};

type InterpreterScreenProps = {
  language: InterpreterLanguage;
  recording: boolean;
  configured: boolean;
  listening: boolean;
  level: number;
  lines: InterpreterLine[];
  activeLineId?: string;
  follow: boolean;
  error?: string;

  scrollRef?: RefObject<HTMLDivElement | null>;

  onLanguageChange: (
    language: InterpreterLanguage,
  ) => void;

  onStart: () => void;
  onStop: () => void;
  onReturnLive: () => void;

  onScrollStart?: () => void;
  onScroll?: (
    element: HTMLDivElement,
  ) => void;
};

function WaveSymbol({
  className,
}: {
  className: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 192 192"
      aria-hidden="true"
    >
      <path
        d="M39 97h20l12-30 19 61 18-80 18 77 12-28h17"
        fill="none"
        stroke="currentColor"
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function InterpreterScreen({
  language,
  recording,
  configured,
  listening,
  level,
  lines,
  activeLineId,
  follow,
  error,
  scrollRef,
  onLanguageChange,
  onStart,
  onStop,
  onReturnLive,
  onScrollStart,
  onScroll,
}: InterpreterScreenProps) {
  return (
    <section
      className={`interpreter-screen ${
        recording
          ? 'is-recording'
          : 'is-idle'
      }`}
    >
      <header className="interpreter-topbar">
        <select
          className="interpreter-language"
          aria-label="对译语言"
          value={language}
          disabled={recording}
          onChange={event =>
            onLanguageChange(
              event.target
                .value as InterpreterLanguage,
            )
          }
        >
          <option value="it">
            Italiano → 中文
          </option>

          <option value="zh">
            中文 → Italiano
          </option>
        </select>

        {recording && (
          <button
            className="interpreter-exit"
            type="button"
            onClick={onStop}
          >
            结束
          </button>
        )}
      </header>

      {!recording ? (
        <div className="interpreter-idle">
          <button
            className="interpreter-start"
            type="button"
            aria-label="开始同传"
            disabled={!configured}
            onClick={onStart}
          >
            <WaveSymbol className="start-symbol" />
          </button>
        </div>
      ) : (
        <div className="interpreter-transcript">
          <div
            className="interpreter-scroll"
            ref={scrollRef}
            aria-live="polite"
            onWheel={onScrollStart}
            onTouchStart={onScrollStart}
            onScroll={event =>
              onScroll?.(
                event.currentTarget,
              )
            }
          >
            <div className="interpreter-lines">
              {lines.map(line => (
                <article
                  className={`interpreter-line ${
                    line.id ===
                    activeLineId
                      ? 'active'
                      : ''
                  }`}
                  key={line.id}
                >
                  <p className="interpreter-source">
                    {line.source}
                  </p>

                  {line.translation && (
                    <p className="interpreter-translation">
                      {line.translation}
                    </p>
                  )}
                </article>
              ))}
            </div>
          </div>

          {!follow && (
            <button
              className="interpreter-return"
              type="button"
              onClick={onReturnLive}
            >
              回到当前
            </button>
          )}
        </div>
      )}

      <div
        className="interpreter-signal"
        aria-hidden="true"
      >
        {listening ? (
          <div
            className="signal-moving"
            style={{
              height: `${
                22 +
                Math.max(
                  0,
                  Math.min(1, level),
                ) *
                  12
              }px`,
            }}
          >
            <WaveSymbol className="signal-symbol" />
          </div>
        ) : (
          <span className="signal-still" />
        )}
      </div>

      {error && (
        <div
          className="interpreter-error"
          role="status"
        >
          {error}
        </div>
      )}
    </section>
  );
}
