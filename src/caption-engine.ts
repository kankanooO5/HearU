export type CaptionLine = {
  id: string;
  order: number;
  start: number;
  end: number;

  stable: string;
  active: string;
  locked: boolean;

  translation: string;

  /*
   * 保留旧字段，兼容 IndexedDB 中已有记录。
   */
  translatedChars: number;
  lastQueuedAt: number;
};

export type TranslationTask = {
  id: string;
  text: string;

  revision: number;

  mode:
    | 'fixed'
    | 'active';

  sourceStart: number;
  sourceEnd: number;
};

const CONTINUATION_WINDOW_SECONDS =
  6;

const MAX_CONTINUATION_LENGTH =
  600;

/*
 * 为了避免把 AssemblyAI 很短的技术 Turn
 * 误认为真正句子，这里对“可冻结句号”
 * 保持保守。
 */
const MIN_FIXED_WORDS = 9;
const MIN_FIXED_CHARS = 45;

/*
 * 活动尾巴允许持续覆盖翻译，
 * 但不需要每几个字就请求一次。
 */
const FIRST_TRANSLATION_DELAY_MS =
  900;

const ACTIVE_TRANSLATION_REFRESH_MS =
  1800;

const LOCKED_TRANSLATION_REFRESH_MS =
  1100;

const SMALL_CHANGE_DELAY_MS =
  2600;

const MIN_TRANSLATION_LENGTH = 5;
const SMALL_CHANGE_CHARS = 8;

function comparable(
  text: string,
) {
  return text
    .toLocaleLowerCase('it')
    .replace(
      /[^\p{L}\p{N}]+/gu,
      '',
    );
}

function joinText(
  left: string,
  right: string,
) {
  const a =
    left.trim();

  const b =
    right.trim();

  if (!a) return b;
  if (!b) return a;

  return `${a} ${b}`;
}

function visibleSource(
  line: CaptionLine,
) {
  return joinText(
    line.stable,
    line.active,
  );
}

function hasTerminalPunctuation(
  text: string,
) {
  return /[.!?。！？…]["'”’）)\]]*$/u
    .test(
      text.trim(),
    );
}

/*
 * 技术 Turn 很短时，AssemblyAI 加上的句号
 * 更可能只是临时断句。
 *
 * 例如：
 *   Non è.
 *   D'Europa.
 *
 * 下一 Turn 接上来时把这种临时句号撤掉。
 */
function shouldSoftenEnding(
  text: string,
) {
  const value =
    text.trim();

  if (
    !hasTerminalPunctuation(
      value,
    )
  ) {
    return false;
  }

  const withoutEnding =
    value.replace(
      /[.!?。！？…]+["'”’）)\]]*$/u,
      '',
    );

  const lastBoundary =
    Math.max(
      withoutEnding.lastIndexOf(
        '.',
      ),
      withoutEnding.lastIndexOf(
        '!',
      ),
      withoutEnding.lastIndexOf(
        '?',
      ),
      withoutEnding.lastIndexOf(
        '。',
      ),
      withoutEnding.lastIndexOf(
        '！',
      ),
      withoutEnding.lastIndexOf(
        '？',
      ),
    );

  const clause =
    withoutEnding
      .slice(
        lastBoundary + 1,
      )
      .trim();

  const words =
    clause
      .split(/\s+/)
      .filter(Boolean)
      .length;

  const compact =
    clause.replace(
      /\s+/g,
      '',
    ).length;

  return (
    words < 6 &&
    compact < 32
  );
}

function softenTrailingPunctuation(
  text: string,
) {
  return text
    .trim()
    .replace(
      /[.!?。！？…]+(["'”’）)\]]*)$/u,
      '$1',
    )
    .trimEnd();
}

/*
 * 已经有后文出现，并且前面这一段足够像完整句子，
 * 才把句号视为“可以冻结”的边界。
 */
function confirmedBoundary(
  source: string,
  start: number,
) {
  const remainder =
    source.slice(start);

  const pattern =
    /[.!?。！？]+["'”’）)\]]*/gu;

  let best = start;
  let segmentStart = start;

  for (
    const match of
    remainder.matchAll(pattern)
  ) {
    const relativeEnd =
      (match.index ?? 0) +
      match[0].length;

    const end =
      start +
      relativeEnd;

    /*
     * 句号必须已经有后文，
     * 最末尾正在说的句子继续保持 active。
     */
    const after =
      source
        .slice(end)
        .trim();

    if (
      after.length <
      3
    ) {
      continue;
    }

    const candidate =
      source
        .slice(
          segmentStart,
          end,
        )
        .trim();

    const words =
      candidate
        .split(/\s+/)
        .filter(Boolean)
        .length;

    const compact =
      candidate.replace(
        /\s+/g,
        '',
      ).length;

    if (
      words >=
        MIN_FIXED_WORDS ||
      compact >=
        MIN_FIXED_CHARS
    ) {
      best = end;
      segmentStart = end;
    }
  }

  return best;
}

function punctuationFor(
  source: string,
) {
  const value =
    source.trim();

  if (
    /[?？]["'”’）)\]]*$/u.test(
      value,
    )
  ) {
    return '？';
  }

  if (
    /[!！]["'”’）)\]]*$/u.test(
      value,
    )
  ) {
    return '！';
  }

  return '。';
}

function ensureTranslationEnding(
  translation: string,
  source: string,
) {
  const value =
    translation.trim();

  if (!value) {
    return '';
  }

  if (
    /[.!?。！？…]["'”’）)\]]*$/u.test(
      value,
    )
  ) {
    return value;
  }

  if (
    !hasTerminalPunctuation(
      source,
    )
  ) {
    return value;
  }

  return (
    value +
    punctuationFor(source)
  );
}

export class CaptionEngine {
  private lines =
    new Map<
      string,
      CaptionLine
    >();

  private sequence = 0;

  /*
   * ASR Turn -> HearU UI 长句。
   */
  private turnTargets =
    new Map<
      string,
      string
    >();

  private turnPrefixes =
    new Map<
      string,
      string
    >();

  /*
   * sourceStart 之前已经进入“冻结翻译区”。
   *
   * 这里在任务入队时就向前推进，
   * 防止同一稳定前缀重复送 API。
   */
  private fixedSourceEnd =
    new Map<
      string,
      number
    >();

  private fixedTranslation =
    new Map<
      string,
      string
    >();

  private activeTranslation =
    new Map<
      string,
      string
    >();

  private queuedActiveSource =
    new Map<
      string,
      string
    >();

  private observedActiveAt =
    new Map<
      string,
      number
    >();

  private translationRevision =
    new Map<
      string,
      number
    >();

  private appliedActiveRevision =
    new Map<
      string,
      number
    >();

  constructor(
    private onChange: (
      lines: CaptionLine[],
    ) => void,
  ) {}

  get snapshot() {
    return [
      ...this.lines.values(),
    ].sort(
      (a, b) =>
        a.order - b.order,
    );
  }

  restore(
    lines: CaptionLine[],
  ) {
    this.lines =
      new Map(
        lines.map(
          line => [
            line.id,
            { ...line },
          ],
        ),
      );

    this.sequence =
      Math.max(
        0,
        ...lines.map(
          line =>
            line.order + 1,
        ),
      );

    this.turnTargets.clear();
    this.turnPrefixes.clear();

    this.fixedSourceEnd.clear();
    this.fixedTranslation.clear();
    this.activeTranslation.clear();

    this.queuedActiveSource.clear();
    this.observedActiveAt.clear();

    this.translationRevision.clear();
    this.appliedActiveRevision.clear();

    /*
     * 历史记录已有译文时，
     * 把它视为最终结果，不重新翻译。
     */
    for (
      const line of
      lines
    ) {
      if (
        line.translation.trim()
      ) {
        this.fixedSourceEnd.set(
          line.id,
          visibleSource(
            line,
          ).length,
        );

        this.fixedTranslation.set(
          line.id,
          line.translation.trim(),
        );
      }
    }

    this.emit();
  }

  private createLine(
    id: string,
    at: number,
  ) {
    const line:
      CaptionLine = {
        id,
        order:
          this.sequence++,

        start: at,
        end: at,

        stable: '',
        active: '',
        locked: false,

        translation: '',

        translatedChars: 0,
        lastQueuedAt: 0,
      };

    this.lines.set(
      id,
      line,
    );

    this.fixedSourceEnd.set(
      id,
      0,
    );

    return line;
  }

  private previousLine() {
    const snapshot =
      this.snapshot;

    return (
      snapshot[
        snapshot.length - 1
      ] ?? null
    );
  }

  private resolveTurn(
    turnId: string,
    at: number,
  ) {
    const mapped =
      this.turnTargets.get(
        turnId,
      );

    if (mapped) {
      const line =
        this.lines.get(
          mapped,
        );

      if (line) {
        return line;
      }
    }

    const direct =
      this.lines.get(
        turnId,
      );

    if (direct) {
      this.turnTargets.set(
        turnId,
        direct.id,
      );

      if (
        !this.turnPrefixes.has(
          turnId,
        )
      ) {
        this.turnPrefixes.set(
          turnId,
          '',
        );
      }

      return direct;
    }

    const previous =
      this.previousLine();

    const canContinue =
      previous &&
      previous.locked &&
      at -
        previous.end <=
        CONTINUATION_WINDOW_SECONDS &&
      visibleSource(
        previous,
      ).length <
        MAX_CONTINUATION_LENGTH;

    if (canContinue) {
      let prefix =
        visibleSource(
          previous,
        ).trim();

      const fixedEnd =
        this.fixedSourceEnd.get(
          previous.id,
        ) ?? 0;

      /*
       * 只允许修改尚未冻结的尾巴。
       * 已固定的句号永远不再动。
       */
      const unfixedTail =
        prefix.slice(
          fixedEnd,
        );

      if (
        unfixedTail &&
        shouldSoftenEnding(
          unfixedTail,
        )
      ) {
        prefix =
          prefix.slice(
            0,
            fixedEnd,
          ) +
          softenTrailingPunctuation(
            unfixedTail,
          );
      }

      this.turnTargets.set(
        turnId,
        previous.id,
      );

      this.turnPrefixes.set(
        turnId,
        prefix,
      );

      previous.stable =
        prefix;

      previous.active = '';
      previous.locked = false;

      return previous;
    }

    const line =
      this.createLine(
        turnId,
        at,
      );

    this.turnTargets.set(
      turnId,
      line.id,
    );

    this.turnPrefixes.set(
      turnId,
      '',
    );

    return line;
  }

  committed(
    id: string,
    at: number,
  ) {
    this.resolveTurn(
      id,
      at,
    );

    this.emit();
  }

  partial(
    id: string,
    text: string,
    at: number,
  ) {
    if (!text) {
      return;
    }

    const line =
      this.resolveTurn(
        id,
        at,
      );

    const prefix =
      this.turnPrefixes.get(
        id,
      ) ?? '';

    line.stable =
      prefix;

    line.active =
      text.trim();

    line.locked = false;
    line.end = at;

    this.emit();
  }

  complete(
    id: string,
    finalText: string,
    at: number,
  ) {
    const line =
      this.resolveTurn(
        id,
        at,
      );

    const prefix =
      this.turnPrefixes.get(
        id,
      ) ?? '';

    const visible =
      line.active.trim();

    const final =
      finalText.trim();

    if (
      !prefix &&
      !visible &&
      !final
    ) {
      this.lines.delete(
        line.id,
      );

      this.emit();
      return;
    }

    let segment =
      final || visible;

    if (
      visible &&
      final
    ) {
      const words =
        visible.split(
          /\s+/,
        );

      const fixed =
        words.slice(
          0,
          Math.max(
            0,
            words.length - 2,
          ),
        );

      const finalWords =
        final.split(
          /\s+/,
        );

      const substitutions =
        fixed.filter(
          (
            word,
            index,
          ) =>
            comparable(
              word,
            ) !==
            comparable(
              finalWords[
                index
              ] ?? '',
            ),
        ).length;

      const ordered =
        finalWords.length >=
          fixed.length &&
        substitutions <= 1;

      segment =
        ordered
          ? final
          : visible;
    }

    line.stable =
      joinText(
        prefix,
        segment,
      );

    line.active = '';
    line.locked = true;
    line.end = at;

    this.emit();
  }

  private composeTranslation(
    id: string,
  ) {
    const fixed =
      this.fixedTranslation
        .get(id)
        ?.trim() ?? '';

    const active =
      this.activeTranslation
        .get(id)
        ?.trim() ?? '';

    return joinText(
      fixed,
      active,
    );
  }

  attachTranslation(
    task: TranslationTask,
    translated: string,
  ) {
    const line =
      this.lines.get(
        task.id,
      );

    if (
      !line ||
      !translated.trim()
    ) {
      return;
    }

    if (
      task.mode ===
      'fixed'
    ) {
      const previous =
        this.fixedTranslation
          .get(
            task.id,
          ) ?? '';

      const next =
        ensureTranslationEnding(
          translated,
          task.text,
        );

      this.fixedTranslation.set(
        task.id,
        joinText(
          previous,
          next,
        ),
      );

      /*
       * 旧 active 可能包含刚刚被冻结的内容。
       * 固定译文回来以后把旧 active 清掉，
       * 后续只重新翻译新的尾巴。
       */
      this.activeTranslation.delete(
        task.id,
      );

      this.appliedActiveRevision.delete(
        task.id,
      );

      line.translation =
        this.composeTranslation(
          task.id,
        );

      this.emit();
      return;
    }

    /*
     * 如果这个 active 请求发出以后，
     * stable prefix 又向前推进了，
     * 那这个结果已经过期，直接丢弃。
     */
    const currentStart =
      this.fixedSourceEnd.get(
        task.id,
      ) ?? 0;

    if (
      task.sourceStart !==
      currentStart
    ) {
      return;
    }

    const applied =
      this
        .appliedActiveRevision
        .get(
          task.id,
        ) ?? 0;

    if (
      task.revision <
      applied
    ) {
      return;
    }

    this
      .appliedActiveRevision
      .set(
        task.id,
        task.revision,
      );

    this.activeTranslation.set(
      task.id,
      ensureTranslationEnding(
        translated,
        task.text,
      ),
    );

    line.translation =
      this.composeTranslation(
        task.id,
      );

    this.emit();
  }

  translationTasks(
    now: number,
  ): TranslationTask[] {
    const tasks:
      TranslationTask[] = [];

    for (
      const line of
      this.snapshot
    ) {
      const source =
        visibleSource(
          line,
        ).trim();

      if (!source) {
        continue;
      }

      let fixedStart =
        this.fixedSourceEnd.get(
          line.id,
        ) ?? 0;

      /*
       * 先寻找已经被后文确认的句号。
       *
       * 这部分以后永远不会再重新翻译。
       */
      const fixedEnd =
        confirmedBoundary(
          source,
          fixedStart,
        );

      if (
        fixedEnd >
        fixedStart
      ) {
        const text =
          source
            .slice(
              fixedStart,
              fixedEnd,
            )
            .trim();

        if (text) {
          const revision =
            (
              this
                .translationRevision
                .get(
                  line.id,
                ) ?? 0
            ) + 1;

          this
            .translationRevision
            .set(
              line.id,
              revision,
            );

          tasks.push({
            id: line.id,
            text,
            revision,
            mode: 'fixed',
            sourceStart:
              fixedStart,
            sourceEnd:
              fixedEnd,
          });

          /*
           * 入队即预留这个区域。
           * 防止下一次 500ms tick
           * 再把同一段送一遍 API。
           */
          this.fixedSourceEnd.set(
            line.id,
            fixedEnd,
          );

          fixedStart =
            fixedEnd;

          this.queuedActiveSource.delete(
            line.id,
          );

          this.observedActiveAt.set(
            line.id,
            now,
          );
        }
      }

      /*
       * 接下来只处理尚未冻结的尾巴。
       */
      const activeSource =
        source
          .slice(
            fixedStart,
          )
          .trim();

      if (
        activeSource.length <
        MIN_TRANSLATION_LENGTH
      ) {
        continue;
      }

      const previousSource =
        this
          .queuedActiveSource
          .get(
            line.id,
          ) ?? '';

      if (
        previousSource ===
        activeSource
      ) {
        continue;
      }

      let observedAt =
        this
          .observedActiveAt
          .get(
            line.id,
          );

      if (
        observedAt ===
        undefined
      ) {
        observedAt = now;

        this
          .observedActiveAt
          .set(
            line.id,
            now,
          );
      }

      if (
        !previousSource &&
        now -
          observedAt <
          FIRST_TRANSLATION_DELAY_MS
      ) {
        continue;
      }

      const sinceLast =
        now -
        line.lastQueuedAt;

      if (
        previousSource
      ) {
        const requiredDelay =
          line.locked
            ? LOCKED_TRANSLATION_REFRESH_MS
            : ACTIVE_TRANSLATION_REFRESH_MS;

        if (
          sinceLast <
          requiredDelay
        ) {
          continue;
        }

        const change =
          Math.abs(
            activeSource.length -
              previousSource.length,
          );

        if (
          change <
            SMALL_CHANGE_CHARS &&
          sinceLast <
            SMALL_CHANGE_DELAY_MS
        ) {
          continue;
        }
      }

      const revision =
        (
          this
            .translationRevision
            .get(
              line.id,
            ) ?? 0
        ) + 1;

      this
        .translationRevision
        .set(
          line.id,
          revision,
        );

      this
        .queuedActiveSource
        .set(
          line.id,
          activeSource,
        );

      line.translatedChars =
        fixedStart +
        activeSource.length;

      line.lastQueuedAt =
        now;

      tasks.push({
        id: line.id,
        text: activeSource,
        revision,
        mode: 'active',
        sourceStart:
          fixedStart,
        sourceEnd:
          source.length,
      });
    }

    return tasks;
  }

  private emit() {
    this.onChange(
      this.snapshot,
    );
  }
}

export class TranslationQueue {
  private queued:
    TranslationTask[] = [];

  private running = false;

  private timer:
    ReturnType<
      typeof setTimeout
    > | null = null;

  constructor(
    private translate: (
      tasks:
        TranslationTask[],
    ) =>
      Promise<string[]>,

    private complete: (
      task:
        TranslationTask,
      text: string,
    ) => void,

    private onError: (
      message: string,
    ) => void,
  ) {}

  add(
    tasks:
      TranslationTask[],
  ) {
    for (
      const task of
      tasks
    ) {
      /*
       * fixed 任务不能覆盖：
       * 每一段都是以后永不重译的稳定前缀。
       */
      if (
        task.mode ===
        'fixed'
      ) {
        this.queued.push(
          task,
        );

        continue;
      }

      /*
       * active 尾巴只保留最新快照。
       */
      const existing =
        this.queued.findIndex(
          item =>
            item.id ===
              task.id &&
            item.mode ===
              'active',
        );

      if (
        existing >= 0
      ) {
        this.queued[
          existing
        ] = task;
      } else {
        this.queued.push(
          task,
        );
      }
    }

    void this.drain();
  }

  get length() {
    return (
      this.queued.length +
      Number(
        this.running,
      )
    );
  }

  async drain() {
    if (
      this.running ||
      this.timer
    ) {
      return;
    }

    this.running = true;

    try {
      while (
        this.queued.length
      ) {
        const take =
          this.queued.length >=
          4
            ? Math.min(
                3,
                this.queued.length,
              )
            : 1;

        const group =
          this.queued.splice(
            0,
            take,
          );

        try {
          const results =
            await this.translate(
              group,
            );

          group.forEach(
            (
              task,
              index,
            ) =>
              this.complete(
                task,
                results[
                  index
                ] ?? '',
              ),
          );
        } catch (
          error
        ) {
          /*
           * fixed 必须重试。
           *
           * active 如果已经有更新版本在队列里，
           * 就不要把旧版本重新塞回去。
           */
          for (
            const task of
            [...group].reverse()
          ) {
            if (
              task.mode ===
              'active'
            ) {
              const newer =
                this.queued.some(
                  item =>
                    item.id ===
                      task.id &&
                    item.mode ===
                      'active' &&
                    item.revision >
                      task.revision,
                );

              if (newer) {
                continue;
              }
            }

            this.queued.unshift(
              task,
            );
          }

          this.onError(
            error instanceof Error
              ? error.message
              : String(
                  error,
                ),
          );

          this.timer =
            setTimeout(
              () => {
                this.timer =
                  null;

                void this.drain();
              },
              5000,
            );

          break;
        }
      }
    } finally {
      this.running =
        false;
    }
  }

  dispose() {
    if (this.timer) {
      clearTimeout(
        this.timer,
      );
    }

    this.timer = null;
    this.queued = [];
  }
}
