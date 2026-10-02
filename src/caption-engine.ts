export type CaptionLine = {
  id: string; order: number; start: number; end: number;
  stable: string; active: string; locked: boolean; translation: string;
  translatedChars: number; lastQueuedAt: number;
};
export type TranslationTask = { id: string; text: string };

function comparable(text: string) { return text.toLocaleLowerCase('it').replace(/[^\p{L}\p{N}]+/gu, ''); }

export class CaptionEngine {
  private lines = new Map<string, CaptionLine>();
  private sequence = 0;
  constructor(private onChange: (lines: CaptionLine[]) => void) {}
  get snapshot() { return [...this.lines.values()].sort((a, b) => a.order - b.order); }
  restore(lines: CaptionLine[]) {
    this.lines = new Map(lines.map(line => [line.id, { ...line }]));
    this.sequence = Math.max(0, ...lines.map(line => line.order + 1));
    this.emit();
  }
  private ensure(id: string, at: number) {
    let line = this.lines.get(id);
    if (!line) {
      line = { id, order: this.sequence++, start: at, end: at, stable: '', active: '', locked: false, translation: '', translatedChars: 0, lastQueuedAt: 0 };
      this.lines.set(id, line);
    }
    return line;
  }
  committed(id: string, at: number) { this.ensure(id, at); this.emit(); }
  partial(id: string, text: string, at: number) {
    if (!text) return;
    const line = this.ensure(id, at);
    if (line.locked) return;

    line.stable = '';
    line.active = text;
    line.end = at;

    this.emit();
  }
  complete(id: string, finalText: string, at: number) {
    const line = this.ensure(id, at);
    if (line.locked) return;
    const visible = (line.stable + line.active).trim();
    const final = finalText.trim();
    if (!visible && !final) { this.lines.delete(id); this.emit(); return; }
    if (visible && final) {
      const words = visible.split(/\s+/);
      const fixed = words.slice(0, Math.max(0, words.length - 2));
      const finalWords = final.split(/\s+/);
      const substitutions = fixed.filter((word, index) => comparable(word) !== comparable(finalWords[index])).length;
      const ordered = finalWords.length >= fixed.length && substitutions <= 1;
      line.stable = ordered ? final : visible + (/[.!?。！？]$/.test(final) && !/[.!?。！？]$/.test(visible) ? final.slice(-1) : '');
    } else line.stable = final || visible;
    line.active = '';
    line.locked = true;
    line.end = at;
    this.emit();
  }
  attachTranslation(id: string, translated: string) {
    const line = this.lines.get(id);
    if (!line || !translated) return;
    line.translation += (line.translation ? ' ' : '') + translated.trim();
    this.emit();
  }
  translationTasks(now: number): TranslationTask[] {
    const tasks: TranslationTask[] = [];
    for (const line of this.snapshot) {
      const source = line.stable.trim();
      const tail = source.slice(line.translatedChars).trim();
      const words = tail.split(/\s+/).filter(Boolean);
      if (!tail || (!line.locked && (words.length < 4 || now - line.lastQueuedAt < 1700))) continue;
      tasks.push({ id: line.id, text: tail });
      line.translatedChars = source.length;
      line.lastQueuedAt = now;
    }
    return tasks;
  }
  private emit() { this.onChange(this.snapshot); }
}

export class TranslationQueue {
  private queued: TranslationTask[] = [];
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private translate: (tasks: TranslationTask[]) => Promise<string[]>, private complete: (id: string, text: string) => void, private onError: (message: string) => void) {}
  add(tasks: TranslationTask[]) { this.queued.push(...tasks); void this.drain(); }
  get length() { return this.queued.length + Number(this.running); }
  async drain() {
    if (this.running || this.timer) return;
    this.running = true;
    try {
      while (this.queued.length) {
        const take = this.queued.length >= 4 ? Math.min(3, this.queued.length) : 1;
        const group = this.queued.splice(0, take);
        try {
          const results = await this.translate(group);
          group.forEach((task, index) => this.complete(task.id, results[index] || ''));
        } catch (error) {
          this.queued.unshift(...group);
          this.onError(error instanceof Error ? error.message : String(error));
          this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, 5000);
          break;
        }
      }
    } finally { this.running = false; }
  }
  dispose() { if (this.timer) clearTimeout(this.timer); this.timer = null; this.queued = []; }
}
