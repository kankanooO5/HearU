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
const FRAME_SAMPLES = 1600;
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
    const input = new Float32Array(
      this.carry.length + inputFrame.length,
    );

    input.set(this.carry);
    input.set(inputFrame, this.carry.length);

    const ratio =
      this.inputRate / TARGET_SAMPLE_RATE;

    const chunks: ArrayBuffer[] = [];

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

  private connectedAt = 0;
  private lastTranscriptAt = 0;
  private lastVoice = 0;
  private warnedAt = 0;
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

  async start() {
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

    // iOS Safari requires Web Audio to be unlocked directly
    // from the user's tap gesture. Do this before any async
    // microphone permission flow.
    this.context = new AudioContext();

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
      await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });

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
      await this.startAudioPipeline();

      this.startRecorder();

      this.started = Date.now();

      void this.connect();
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
          : new Float32Array(event.data);

      for (
        const chunk of
        this.encoder.push(input)
      ) {
        this.sendAudio(chunk);
      }
    };

    this.source.connect(this.analyser);
    this.source.connect(this.worklet);

    this.analyser.connect(this.silent);
    this.worklet.connect(this.silent);

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
    }, 100);
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
          String(TARGET_SAMPLE_RATE),
        encoding: "pcm_s16le",
        format_turns: "true",
        speech_model:
          this.language === "zh"
            ? "whisper-rt"
            : "universal-streaming-multilingual",
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
      this.opening ||
      !this.stream
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
      const secret = await token(
        this.language,
        this.vocabulary,
      );

      if (
        this.closed ||
        this.closing
      ) {
        return;
      }

      const socket =
        new WebSocket(
          this.buildSocketUrl(secret),
        );

      socketForCleanup = socket;

      const namespace =
        `rt${++this.connectionCounter}:`;

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

          this.connectedAt = Date.now();
          this.lastTranscriptAt =
            this.connectedAt;

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

          let message: any;

          try {
            message =
              JSON.parse(event.data);
          } catch {
            return;
          }

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

          const at = this.elapsed;

          const id =
            namespace +
            String(
              turn.turn_order ?? 0,
            );

          const text =
            typeof turn.transcript ===
            "string"
              ? turn.transcript
              : "";

          this.lastTranscriptAt =
            Date.now();

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

    const now = Date.now();

    this.events.level(
      Math.min(1, rms * 18),
    );

    if (rms > 0.006) {
      this.lastVoice = now;
    }

    if (
      this.socket?.readyState ===
        WebSocket.OPEN &&
      this.lastVoice &&
      now - this.lastVoice < 500 &&
      now -
        Math.max(
          this.lastTranscriptAt,
          this.connectedAt,
        ) >
        8000 &&
      now - this.warnedAt > 8000
    ) {
      this.events.error(
        "麦克风已收到声音，识别服务仍在处理当前语音",
      );

      this.warnedAt = now;
    }
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
          type: "Terminate",
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
  }
}
