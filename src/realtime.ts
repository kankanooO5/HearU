export type StreamStatus =
  | "connecting"
  | "listening"
  | "recovering"
  | "interrupted";

type Events = {
  status: (status: StreamStatus) => void;
  partial: (id: string, text: string, at: number) => void;
  complete: (id: string, text: string, at: number) => void;
  committed: (id: string, at: number) => void;
  level: (value: number) => void;
  waveform: (values: number[]) => void;
  error: (message: string) => void;
};

type TurnMessage = {
  type: "Turn";
  turn_order?: number;
  transcript?: string;
  end_of_turn?: boolean;
  turn_is_formatted?: boolean;
  error?: string;
};

const TARGET_SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 800;
const MIN_FINAL_SAMPLES = 800;

async function token(
  language: "it" | "zh",
  vocabulary: string[],
): Promise<string> {
  const response = await fetch("/api/transcription-token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      language,
      vocabulary,
    }),
  });

  const result = await response.json();

  if (
    !response.ok ||
    typeof result.token !== "string" ||
    !result.token
  ) {
    throw new Error(
      result.error || "在线识别连接失败",
    );
  }

  return result.token;
}

class Pcm16Framer {
  private carry = new Float32Array(0);
  private position = 0;

  private frame =
    new Int16Array(FRAME_SAMPLES);

  private frameLength = 0;

  constructor(
    private inputRate: number,
  ) {}

  push(inputFrame: Float32Array): ArrayBuffer[] {
    const chunks: ArrayBuffer[] = [];

    /*
     * 正常路径：
     * AudioContext 已经是 16 kHz，
     * 这里只做 Float32 → PCM16。
     *
     * 不再让已经是 16 kHz 的音频
     * 经过一次没有意义的插值器。
     */
    if (
      this.inputRate ===
      TARGET_SAMPLE_RATE
    ) {
      for (
        let i = 0;
        i < inputFrame.length;
        i++
      ) {
        this.writeSample(
          inputFrame[i],
          chunks,
        );
      }

      return chunks;
    }

    /*
     * 极少数浏览器如果没有兑现
     * 16 kHz AudioContext 请求，
     * 才进入兼容重采样路径。
     */
    const input = new Float32Array(
      this.carry.length + inputFrame.length,
    );

    input.set(this.carry);
    input.set(inputFrame, this.carry.length);

    const ratio =
      this.inputRate / TARGET_SAMPLE_RATE;

    while (
      this.position + 1 < input.length
    ) {
      const left =
        Math.floor(this.position);

      const fraction =
        this.position - left;

      const sample =
        input[left] +
        (
          input[left + 1] -
          input[left]
        ) *
          fraction;

      this.writeSample(sample, chunks);

      this.position += ratio;
    }

    const consumed =
      Math.floor(this.position);

    this.carry =
      input.slice(consumed);

    this.position -= consumed;

    return chunks;
  }

  flush(): ArrayBuffer | null {
    if (!this.frameLength) {
      return null;
    }

    const length = Math.max(
      MIN_FINAL_SAMPLES,
      this.frameLength,
    );

    const finalFrame =
      new Int16Array(length);

    finalFrame.set(
      this.frame.subarray(
        0,
        this.frameLength,
      ),
    );

    this.frameLength = 0;

    return finalFrame.buffer;
  }

  private writeSample(
    sample: number,
    chunks: ArrayBuffer[],
  ) {
    const clipped = Math.max(
      -1,
      Math.min(1, sample),
    );

    this.frame[this.frameLength++] =
      clipped < 0
        ? Math.round(clipped * 32768)
        : Math.round(clipped * 32767);

    if (
      this.frameLength === FRAME_SAMPLES
    ) {
      chunks.push(this.frame.buffer);

      this.frame =
        new Int16Array(FRAME_SAMPLES);

      this.frameLength = 0;
    }
  }
}


export class RealtimeStream {
  private socket: WebSocket | null = null;

  private stream: MediaStream | null = null;

  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  private analyser: AnalyserNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private silent: GainNode | null = null;
  private levelData: Float32Array<ArrayBuffer> | null = null;
  private encoder: Pcm16Framer | null = null;

  private monitor:
    ReturnType<typeof setInterval> | null =
      null;

  private recorder: MediaRecorder | null = null;
  private recorderWrites:
    Promise<unknown> = Promise.resolve();

  private started = 0;

  private reconnects = 0;
  private connectionCounter = 0;

  private retry:
    ReturnType<typeof setTimeout> | null =
      null;

  private terminationResolve:
    (() => void) | null = null;

  private closed = false;
  private closing = false;
  private opening = false;

  private initialTokenPromise:
    Promise<{
      secret: string;
      requestedAt: number;
    }> | null = null;

  constructor(
    private language: "it" | "zh",
    private vocabulary: string[],
    private events: Events,
    private saveChunk: (
      blob: Blob,
      format: string,
    ) => Promise<unknown>,
  ) {}

  get elapsed() {
    return this.started
      ? (Date.now() - this.started) / 1000
      : 0;
  }

  async start(
    microphonePromise?:
      Promise<MediaStream>,
  ) {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      !window.AudioWorkletNode
    ) {
      throw new Error(
        "浏览器需要麦克风和 AudioWorklet 支持",
      );
    }

    this.closed = false;
    this.closing = false;

    const requestedAt =
      Date.now();

    this.initialTokenPromise =
      token(
        this.language,
        this.vocabulary,
      ).then(secret => ({
        secret,
        requestedAt,
      }));

    void this.initialTokenPromise
      .catch(() => {});

    /*
     * WebSocket 与麦克风 / AudioWorklet 并行启动。
     * 建立识别连接并不依赖 MediaStream，
     * 不应等麦克风准备完成后才握手。
     */
    void this.connect();

    // iOS Safari requires Web Audio to be unlocked directly
    // from the user's tap gesture. Do this before any async
    // microphone permission flow.
    /*
     * AssemblyAI Streaming 需要 16 kHz PCM16。
     *
     * 直接让 Web Audio 引擎创建 16 kHz context，
     * 由浏览器底层完成设备采样率 → 16 kHz 的转换，
     * 避免 HearU 自己的线性重采样成为远场音质瓶颈。
     */
    this.context =
      new AudioContext({
        sampleRate:
          TARGET_SAMPLE_RATE,
      });

    await this.context.resume();

    await this.context.audioWorklet.addModule(
      "/capture-worklet.js",
    );

    if (this.context.state !== "running") {
      throw new Error(
        "音频系统未能启动，请再次点击开始",
      );
    }

    this.stream =
      await (
        microphonePromise ??
        navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
          },
          video: false,
        })
      );

    this.stream
      .getAudioTracks()
      .forEach((track) => {
        track.onended = () => {
          if (
            !this.closed &&
            !this.closing
          ) {
            this.events.error(
              "麦克风连接已中断，请检查设备",
            );
          }
        };
      });

    try {
      this.started = Date.now();

      await this.startAudioPipeline();

      this.startRecorder();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private async startAudioPipeline() {
    if (!this.stream || !this.context) return;

    this.encoder =
      new Pcm16Framer(
        this.context.sampleRate,
      );

    this.source =
      this.context.createMediaStreamSource(
        this.stream,
      );

    this.analyser =
      this.context.createAnalyser();

    this.analyser.fftSize = 2048;

    this.worklet =
      new AudioWorkletNode(
        this.context,
        "capture-processor",
        {
          processorOptions: {
            frameSamples:
              Math.round(
                this.context
                  .sampleRate *
                0.10,
              ),
          },
        },
      );

    this.silent =
      this.context.createGain();

    this.silent.gain.value = 0;

    this.worklet.port.onmessage = (
      event,
    ) => {
      if (
        this.closed ||
        this.closing ||
        !this.encoder
      ) {
        return;
      }

      const input =
        event.data instanceof Float32Array
          ? event.data
          : new Float32Array(
              event.data,
            );

      for (
        const chunk of
        this.encoder.push(input)
      ) {
        this.sendAudio(chunk);
      }
    };

    /*
     * 唯一实时识别链路：
     *
     * Microphone
     * → Web Audio
     * → PCM16
     * → AssemblyAI
     */
    this.source.connect(
      this.analyser,
    );

    this.source.connect(
      this.worklet,
    );

    this.analyser.connect(
      this.silent,
    );

    this.worklet.connect(
      this.silent,
    );

    this.silent.connect(
      this.context.destination,
    );

    this.levelData =
      new Float32Array(
        new ArrayBuffer(
          this.analyser.fftSize *
            Float32Array.BYTES_PER_ELEMENT,
        ),
      );

    this.monitor = setInterval(() => {
      this.sampleAudioLevel();
    }, 40);
  }

  private startRecorder() {
    if (
      !this.stream ||
      !window.MediaRecorder
    ) {
      return;
    }

    const format = [
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm",
    ].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );

    this.recorder =
      new MediaRecorder(
        this.stream,
        format
          ? { mimeType: format }
          : undefined,
      );

    this.recorder.ondataavailable = (
      event,
    ) => {
      if (!event.data.size) return;

      const type =
        this.recorder?.mimeType ||
        event.data.type;

      this.recorderWrites =
        this.recorderWrites
          .then(() =>
            this.saveChunk(
              event.data,
              type,
            ),
          )
          .catch(() => {
            this.events.error(
              "录音存储空间不足",
            );
          });
    };

    this.recorder.start(30000);
  }

  private buildSocketUrl(
    secret: string,
  ) {
    const params =
      new URLSearchParams({
        token: secret,

        sample_rate:
          String(
            TARGET_SAMPLE_RATE,
          ),

        encoding:
          "pcm_s16le",

        /*
         * HearU 统一使用 AssemblyAI
         * Universal-3.6 Pro Realtime。
         */
        speech_model:
          "universal-3-6-pro",

        /*
         * AssemblyAI Streaming 当前使用
         * language_codes（复数）。
         *
         * HearU 的课堂语言是明确已知的，
         * 因此这里只 steering 到当前语言。
         */
        language_codes:
          this.language,

        /*
         * 与已经验证成功的本地 WAV
         * Streaming 测试保持一致。
         */
        mode:
          "max_accuracy",
      });

    return (
      "wss://streaming.assemblyai.com/v3/ws?" +
      params.toString()
    );
  }

  private async connect() {
    if (
      this.closed ||
      this.closing ||
      this.opening
    ) {
      return;
    }

    this.opening = true;

    this.events.status(
      this.reconnects
        ? "recovering"
        : "connecting",
    );

    let socketForCleanup:
      WebSocket | null = null;

    try {
      let secret: string;

      const prepared =
        this.initialTokenPromise;

      this.initialTokenPromise =
        null;

      if (prepared) {
        const result =
          await prepared;

        secret =
          Date.now() -
              result.requestedAt <
            45000
            ? result.secret
            : await token(
                this.language,
                this.vocabulary,
              );
      } else {
        secret = await token(
          this.language,
          this.vocabulary,
        );
      }

      if (
        this.closed ||
        this.closing
      ) {
        return;
      }

      const socket =
        new WebSocket(
          this.buildSocketUrl(
            secret,
          ),
        );

      socketForCleanup = socket;

      const namespace =
        `rt${++this.connectionCounter}:`;

      /*
       * AssemblyAI 有时会先返回非空 partial，
       * 随后用 transcript="" 的 final Turn
       * 结束同一个 turn。
       *
       * 保存每个 turn 最近一次非空文本，
       * 防止 final 空字符串把已经识别出的词擦掉。
       */
      const lastTurnText =
        new Map<string, string>();

      this.socket = socket;

      socket.addEventListener(
        "open",
        () => {
          if (
            this.closed ||
            this.closing ||
            this.socket !== socket
          ) {
            socket.close();
            return;
          }

          this.reconnects = 0;

          this.events.status(
            "listening",
          );
        },
      );

      socket.addEventListener(
        "message",
        (event) => {
          if (
            this.socket !== socket
          ) {
            return;
          }

          if (
            typeof event.data !==
            "string"
          ) {
            return;
          }

          let message: any;

          try {
            message =
              JSON.parse(event.data);
          } catch {
            return;
          }

          // -------------------------
          // AssemblyAI
          // -------------------------
          if (
            message.type ===
            "Termination"
          ) {
            this.terminationResolve?.();
            return;
          }

          if (
            message.type === "Error"
          ) {
            this.events.error(
              message.error ||
                "识别服务暂时异常",
            );

            return;
          }

          if (
            message.type !== "Turn"
          ) {
            return;
          }

          const turn =
            message as TurnMessage;

          const at =
            this.elapsed;

          const id =
            namespace +
            String(
              turn.turn_order ?? 0,
            );

          const incomingText =
            typeof turn.transcript ===
            "string"
              ? turn.transcript.trim()
              : "";

          if (incomingText) {
            lastTurnText.set(
              id,
              incomingText,
            );
          }

          /*
           * final transcript 为空时，
           * 回退到这个 turn 最近一次非空版本。
           */
          const text =
            incomingText ||
            lastTurnText.get(id) ||
            "";

          if (!turn.end_of_turn) {
            if (text) {
              this.events.partial(
                id,
                text,
                at,
              );
            }

            return;
          }

          if (
            turn.turn_is_formatted ===
            false
          ) {
            if (text) {
              this.events.partial(
                id,
                text,
                at,
              );
            }

            return;
          }

          this.events.complete(
            id,
            text,
            at,
          );

          this.events.committed(
            id,
            at,
          );
        },
      );

      socket.addEventListener(
        "close",
        () => {
          if (
            this.socket !== socket
          ) {
            return;
          }

          this.socket = null;

          if (this.closing) {
            this.terminationResolve?.();
            return;
          }

          if (!this.closed) {
            this.reconnect();
          }
        },
      );
    } catch (error) {
      if (
        socketForCleanup &&
        this.socket ===
          socketForCleanup
      ) {
        this.socket = null;

        socketForCleanup.close();
      }

      if (
        !this.closed &&
        !this.closing
      ) {
        this.events.error(
          error instanceof Error
            ? error.message
            : "实时连接失败",
        );

        this.reconnect();
      }
    } finally {
      this.opening = false;
    }
  }

  private reconnect() {
    if (
      this.closed ||
      this.closing ||
      this.retry
    ) {
      return;
    }

    this.events.status(
      "recovering",
    );

    const delay = Math.min(
      15000,
      800 *
        2 **
          Math.min(
            this.reconnects++,
            5,
          ),
    );

    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, delay);
  }

  private sendAudio(
    chunk: ArrayBuffer,
  ) {
    if (
      this.socket?.readyState !==
      WebSocket.OPEN
    ) {
      return;
    }

    this.socket.send(chunk);
  }

  private sampleAudioLevel() {
    if (
      !this.analyser ||
      !this.levelData ||
      this.closed
    ) {
      return;
    }

    this.analyser
      .getFloatTimeDomainData(
        this.levelData,
      );

    let energy = 0;

    for (
      const sample of
      this.levelData
    ) {
      energy += sample * sample;
    }

    const rms = Math.sqrt(
      energy /
        this.levelData.length,
    );

    this.events.level(
      Math.min(1, rms * 18),
    );

    // 从实际音频中取最近约 60ms。
    // 改成更偏“主波形”的 signed-energy 取样，
    // 再做两次平滑，让可见波峰收成约 1.5 组，
    // 避免像蜈蚣一样太碎。
    const data = this.levelData;
    const count = 13;
    const length = Math.min(
      960,
      data.length,
    );
    const offset =
      data.length - length;

    // 环境噪音时尽量贴近平线；
    // 出现较明确的人声起伏时再明显抬升。
    const activity =
      rms < 0.00012
        ? 0
        : Math.min(
            1,
            Math.sqrt(
              Math.max(
                0,
                rms - 0.00012,
              ) * 380,
            ),
          );

    const reference =
      Math.max(
        0.00045,
        rms * 2.2,
      );

    const waveform: number[] = [];

    for (let i = 0; i < count; i++) {
      const from = offset +
        Math.floor(
          i * length / count,
        );

      const to = offset +
        Math.floor(
          (i + 1) * length / count,
        );

      let signed = 0;
      let weight = 0;

      for (let j = from; j < to; j++) {
        const sample = data[j];
        const abs = Math.abs(sample);

        signed += sample * abs;
        weight += abs;
      }

      const value =
        weight > 1e-6
          ? signed / weight
          : 0;

      waveform.push(
        Math.max(
          -1,
          Math.min(
            1,
            value / reference,
          ),
        ) * activity,
      );
    }

    for (let pass = 0; pass < 2; pass++) {
      const smoothed =
        waveform.map(
          (value, i) => {
            const left =
              waveform[
                Math.max(0, i - 1)
              ] ?? 0;

            const right =
              waveform[
                Math.min(
                  count - 1,
                  i + 1,
                )
              ] ?? 0;

            if (
              i === 0 ||
              i === count - 1
            ) {
              return value * 0.72;
            }

            return (
              left * 0.22 +
              value * 0.56 +
              right * 0.22
            );
          },
        );

      waveform.splice(
        0,
        waveform.length,
        ...smoothed,
      );
    }

    this.events.waveform(waveform);
  }

  async stop() {
    if (
      this.closed ||
      this.closing
    ) {
      return;
    }

    this.closing = true;

    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }

    if (this.monitor) {
      clearInterval(this.monitor);
      this.monitor = null;
    }

    this.worklet?.disconnect();

    const finalAudio =
      this.encoder?.flush();

    if (
      finalAudio &&
      this.socket?.readyState ===
        WebSocket.OPEN
    ) {
      this.socket.send(finalAudio);
    }

    if (
      this.socket?.readyState ===
      WebSocket.OPEN
    ) {
      const socket = this.socket;

      const terminated =
        new Promise<void>(
          (resolve) => {
            this.terminationResolve =
              resolve;
          },
        );

      socket.send(
        JSON.stringify({
          type:
            "Terminate",
        }),
      );

      await Promise.race([
        terminated,
        new Promise<void>(
          (resolve) =>
            setTimeout(
              resolve,
              5000,
            ),
        ),
      ]);

      this.terminationResolve =
        null;
    }

    this.closed = true;

    if (
      this.recorder?.state ===
      "recording"
    ) {
      await new Promise<void>(
        (resolve) => {
          this.recorder!.onstop =
            () => resolve();

          this.recorder!.stop();
        },
      );
    }

    await this.recorderWrites;

    this.stream
      ?.getTracks()
      .forEach((track) =>
        track.stop(),
      );

    this.source?.disconnect();
    this.analyser?.disconnect();
    this.silent?.disconnect();

    this.worklet?.port.close();

    await this.context?.close();

    this.socket?.close();

    this.socket = null;
    this.encoder = null;

    this.initialTokenPromise = null;
  }
}
