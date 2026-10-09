import {
  useEffect,
  useRef,
  type RefObject,
} from 'react';

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
  waveformRef: RefObject<number[]>;
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
  active = false,
  waveformRef,
  level = 0,
}: {
  className: string;
  active?: boolean;
  waveformRef?: RefObject<number[]>;
  level?: number;
}) {
  const pathRef =
    useRef<SVGPathElement | null>(null);

  const levelRef =
    useRef(level);

  levelRef.current = level;

  useEffect(() => {
    if (!active || !waveformRef) return;

    const path = pathRef.current;
    if (!path) return;

    let frameId = 0;
    let previous = performance.now();

    let phase = 0;
    let voiceLevel = 0;
    let noiseFloor = 0.035;

    const draw = (now: number) => {
      const dt = Math.min(
        0.05,
        Math.max(
          0,
          (now - previous) / 1000,
        ),
      );

      previous = now;

      /*
       * waveformRef 里仍然是真实麦克风数据，
       * 但这里不再逐点照抄。
       *
       * 排序后丢掉最弱和最强的部分：
       * - 很弱的环境底噪不主导动画
       * - 敲击、碰撞等极端峰值也不主导动画
       */
      /*
       * level 是真实的整体声音强度。
       *
       * 这里把持续环境声当作背景基线：
       * 只有明显高出背景时，
       * 才认为出现了值得显示的主要声音。
       */
      const rawLevel =
        Math.max(
          0,
          Math.min(
            1,
            levelRef.current,
          ),
        );

      /*
       * 自适应环境底噪。
       *
       * 环境变安静：
       * 快速下降。
       *
       * 环境变响：
       * 非常慢地上升，
       * 避免一句人声立刻被吸收到 noise floor。
       */
      const floorRate =
        rawLevel < noiseFloor
          ? 0.10
          : rawLevel <
            noiseFloor * 1.20
            ? 0.012
            : 0.0015;

      noiseFloor +=
        (
          rawLevel -
          noiseFloor
        ) * floorRate;

      /*
       * 必须明显高于背景，
       * 才开始打开波形。
       *
       * 因此：
       * 只有环境噪音 → 接近平直
       * 突出人声 → 快速展开
       */
      const speechExcess =
        Math.max(
          0,
          rawLevel -
          noiseFloor * 1.65,
        );

      const gateWidth =
        Math.max(
          0.028,
          noiseFloor * 2.0,
        );

      /*
       * 不再在 gateWidth 处直接 clamp 到 1。
       *
       * ratio 可以继续随着声音变大：
       * 0.5x / 1x / 2x / 4x / 8x...
       *
       * 再通过软饱和曲线映射到 0~1，
       * 从而保留中高音量之间的层次。
       */
      const levelRatio =
        speechExcess /
        Math.max(
          gateWidth,
          0.0001,
        );

      const normalized =
        levelRatio /
        (
          levelRatio +
          2.4
        );

      /*
       * 很小的人声继续压低一点，
       * 但正常音量之后仍有足够空间增长。
       */
      const targetLevel =
        Math.pow(
          normalized,
          1.08,
        );

      const responseTime =
        targetLevel >
        voiceLevel
          ? 0.060
          : 0.075;

      voiceLevel +=
        (
          targetLevel -
          voiceLevel
        ) *
        (
          1 -
          Math.exp(
            -dt /
            responseTime,
          )
        );

      /*
       * 波形保持连续流动，
       * 当前整条图标约显示 1.5 个
       * 舒展的声波周期。
       */
      phase +=
        dt *
        (
          5.0 +
          voiceLevel * 7.5
        );

      /*
       * 无突出人声时几乎是一条直线。
       * 真正有人讲话时，最大波幅比之前更大。
       */
      const amplitude =
        0.4 +
        voiceLevel * 68;

      /*
       * 进一步减少可见波峰：
       * 2.5 → 1.5
       *
       * 保留更舒展的主要起伏，
       * 避免图标显得过密。
       */
      const cycles =
        1.5;

      const count = 28;

      const points:
        [number, number][] = [];

      for (
        let i = 0;
        i <= count;
        i++
      ) {
        const u =
          i / count;

        const x =
          24 +
          u * 144;

        /*
         * 两端也保持运动，
         * 但略低于中部幅度，
         * 避免两端突然被截断。
         */
        const envelope =
          0.58 +
          0.42 *
          Math.sin(
            Math.PI * u,
          ) ** 2;

        const wave =
          Math.sin(
            2 *
            Math.PI *
            cycles *
            u -
            phase,
          );

        /*
         * 不再让所有波峰完全共享同一个振幅。
         *
         * waveformRef 里的真实声音变化只作为
         * 轻微的局部修饰，不直接决定曲线形状，
         * 所以不会重新变成杂乱的环境噪声波形。
         */
        const sourceIndex =
          Math.min(
            Math.max(
              0,
              Math.round(
                u *
                (
                  waveformRef.current.length -
                  1
                ),
              ),
            ),
            Math.max(
              0,
              waveformRef.current.length - 1,
            ),
          );

        const localSignal =
          Math.min(
            1,
            Math.abs(
              waveformRef.current[
                sourceIndex
              ] ?? 0
            ),
          );

        /*
         * 只允许局部振幅在整体振幅基础上
         * 上下变化约 25%。
         *
         * 因此三个波峰会有错峰感，
         * 但仍然属于同一条稳定波形。
         */
        const localAmplitude =
          amplitude *
          (
            0.78 +
            localSignal * 0.44
          );

        const y =
          96 -
          wave *
          localAmplitude *
          envelope;

        points.push(
          [x, y],
        );
      }

      /*
       * Catmull-Rom → cubic Bézier。
       * 最终仍然只有一条连续 SVG path，
       * 没有线段之间的断点。
       */
      let d =
        `M ${points[0][0].toFixed(2)}` +
        ` ${points[0][1].toFixed(2)}`;

      for (
        let i = 0;
        i < count;
        i++
      ) {
        const p0 =
          points[
            Math.max(
              0,
              i - 1,
            )
          ];

        const p1 =
          points[i];

        const p2 =
          points[i + 1];

        const p3 =
          points[
            Math.min(
              count,
              i + 2,
            )
          ];

        const c1x =
          p1[0] +
          (
            p2[0] -
            p0[0]
          ) / 6;

        const c1y =
          p1[1] +
          (
            p2[1] -
            p0[1]
          ) / 6;

        const c2x =
          p2[0] -
          (
            p3[0] -
            p1[0]
          ) / 6;

        const c2y =
          p2[1] -
          (
            p3[1] -
            p1[1]
          ) / 6;

        d +=
          ` C ${c1x.toFixed(2)}` +
          ` ${c1y.toFixed(2)}` +
          ` ${c2x.toFixed(2)}` +
          ` ${c2y.toFixed(2)}` +
          ` ${p2[0].toFixed(2)}` +
          ` ${p2[1].toFixed(2)}`;
      }

      path.setAttribute(
        "d",
        d,
      );

      frameId =
        requestAnimationFrame(
          draw,
        );
    };

    if (
      !window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches
    ) {
      frameId =
        requestAnimationFrame(
          draw,
        );
    }

    return () => {
      cancelAnimationFrame(
        frameId,
      );
    };
  }, [active, waveformRef]);

  return (
    <svg
      className={className}
      viewBox="0 0 192 192"
      aria-hidden="true"
    >
      <path
        ref={
          active
            ? pathRef
            : undefined
        }
        d={
          active
            ? "M24 96 H168"
            : "M39 97h20l12-30 19 61 18-80 18 77 12-28h17"
        }
        fill="none"
        stroke="currentColor"
        strokeWidth={
          active
            ? 9
            : 10
        }
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
  waveformRef,
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
        <div className="interpreter-controls">
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

        </div>

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
          <div className="signal-moving">
            <WaveSymbol
              className="signal-symbol"
              active
              waveformRef={waveformRef}
              level={level}
            />
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
