import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/realtime.ts", import.meta.url),
  "utf8",
);

const js = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const { RealtimeStream } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);

test(
  "microphone streams PCM16 through AssemblyAI WebSocket and Turn events reach captions",
  async () => {
    const globalKeys = [
      "navigator",
      "window",
      "AudioContext",
      "AudioWorkletNode",
      "WebSocket",
      "fetch",
    ];

    const originals = Object.fromEntries(
      globalKeys.map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );

    const requests = [];
    const sent = [];
    const received = [];
    const loadedModules = [];

    let socket;
    let worklet;

    class FakePort {
      onmessage = null;

      emit(data) {
        this.onmessage?.({ data });
      }

      close() {}
    }

    class FakeAudioWorkletNode {
      port = new FakePort();

      constructor(_context, name) {
        assert.equal(
          name,
          "capture-processor",
        );

        worklet = this;
      }

      connect() {}

      disconnect() {}
    }

    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readyState = FakeWebSocket.CONNECTING;
      listeners = new Map();

      constructor(url) {
        this.url = url;
        socket = this;
      }

      addEventListener(type, listener) {
        const listeners =
          this.listeners.get(type) || [];

        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(type, event = {}) {
        for (
          const listener of
          this.listeners.get(type) || []
        ) {
          listener(event);
        }
      }

      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.emit("open");
      }

      message(message) {
        this.emit("message", {
          data: JSON.stringify(message),
        });
      }

      send(value) {
        sent.push(value);

        if (typeof value !== "string") {
          return;
        }

        let message;

        try {
          message = JSON.parse(value);
        } catch {
          return;
        }

        if (message.type === "Terminate") {
          queueMicrotask(() => {
            this.message({
              type: "Termination",
            });
          });
        }
      }

      close() {
        if (
          this.readyState ===
          FakeWebSocket.CLOSED
        ) {
          return;
        }

        this.readyState =
          FakeWebSocket.CLOSED;

        this.emit("close");
      }
    }

    class FakeAnalyser {
      fftSize = 2048;

      connect() {}

      disconnect() {}

      getFloatTimeDomainData(buffer) {
        buffer.fill(0);
      }
    }

    class FakeSource {
      connect() {}

      disconnect() {}
    }

    class FakeGain {
      gain = { value: 1 };

      connect() {}

      disconnect() {}
    }

    class FakeAudioContext {
      sampleRate = 48000;
      destination = {};

      audioWorklet = {
        addModule: async (url) => {
          loadedModules.push(url);
        },
      };

      createMediaStreamSource() {
        return new FakeSource();
      }

      createAnalyser() {
        return new FakeAnalyser();
      }

      createGain() {
        return new FakeGain();
      }

      async resume() {}

      async close() {}
    }

    const track = {
      onended: null,
      stop() {},
    };

    const mediaStream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    };

    Object.defineProperties(globalThis, {
      navigator: {
        configurable: true,
        value: {
          mediaDevices: {
            getUserMedia:
              async () => mediaStream,
          },
        },
      },

      window: {
        configurable: true,
        value: {
          AudioWorkletNode:
            FakeAudioWorkletNode,
          MediaRecorder: undefined,
        },
      },

      AudioContext: {
        configurable: true,
        value: FakeAudioContext,
      },

      AudioWorkletNode: {
        configurable: true,
        value: FakeAudioWorkletNode,
      },

      WebSocket: {
        configurable: true,
        value: FakeWebSocket,
      },

      fetch: {
        configurable: true,
        value: async (
          url,
          options = {},
        ) => {
          requests.push({
            url: String(url),
            options,
          });

          if (
            url ===
            "/api/transcription-token"
          ) {
            return Response.json({
              token: "assembly_token",
            });
          }

          throw new Error(
            `Unexpected fetch: ${url}`,
          );
        },
      },
    });

    try {
      const realtime =
        new RealtimeStream(
          "it",
          ["Augusto"],
          {
            status: (value) =>
              received.push([
                "status",
                value,
              ]),

            partial: (id, value) =>
              received.push([
                "partial",
                id,
                value,
              ]),

            complete: (id, value) =>
              received.push([
                "complete",
                id,
                value,
              ]),

            committed: (id) =>
              received.push([
                "committed",
                id,
              ]),

            level: () => {},

            error: (value) =>
              received.push([
                "error",
                value,
              ]),
          },
          async () => {},
        );

      await realtime.start();

      for (
        let i = 0;
        i < 10 && (!socket || !worklet);
        i++
      ) {
        await new Promise(
          (resolve) =>
            setTimeout(resolve, 0),
        );
      }

      assert.ok(socket);
      assert.ok(worklet);

      assert.deepEqual(
        loadedModules,
        ["/capture-worklet.js"],
      );

      const tokenRequest =
        requests.find(
          (request) =>
            request.url ===
            "/api/transcription-token",
        );

      assert.ok(tokenRequest);

      assert.equal(
        tokenRequest.options.method,
        "POST",
      );

      assert.deepEqual(
        JSON.parse(
          tokenRequest.options.body,
        ),
        {
          language: "it",
          vocabulary: ["Augusto"],
        },
      );

      assert.equal(
        requests.length,
        1,
      );

      const socketUrl =
        new URL(socket.url);

      assert.equal(
        socketUrl.origin,
        "wss://streaming.assemblyai.com",
      );

      assert.equal(
        socketUrl.pathname,
        "/v3/ws",
      );

      assert.equal(
        socketUrl.searchParams.get(
          "token",
        ),
        "assembly_token",
      );

      assert.equal(
        socketUrl.searchParams.get(
          "sample_rate",
        ),
        "16000",
      );

      assert.equal(
        socketUrl.searchParams.get(
          "encoding",
        ),
        "pcm_s16le",
      );

      assert.equal(
        socketUrl.searchParams.get(
          "format_turns",
        ),
        "true",
      );

      assert.equal(
        socketUrl.searchParams.get(
          "speech_model",
        ),
        "universal-streaming-multilingual",
      );

      socket.open();

      assert.ok(
        received.some(
          ([type, value]) =>
            type === "status" &&
            value === "listening",
        ),
      );

      worklet.port.emit(
        new Float32Array(4800).fill(
          0.5,
        ),
      );

      const audioFrames =
        sent.filter(
          (value) =>
            value instanceof ArrayBuffer,
        );

      assert.equal(
        audioFrames.length,
        1,
      );

      assert.equal(
        audioFrames[0].byteLength,
        3200,
      );

      assert.equal(
        new Int16Array(
          audioFrames[0],
        )[0],
        16384,
      );

      socket.message({
        type: "Turn",
        turn_order: 7,
        transcript: "Augusto è",
        end_of_turn: false,
      });

      socket.message({
        type: "Turn",
        turn_order: 7,
        transcript:
          "Augusto è il primo imperatore romano",
        end_of_turn: true,
        turn_is_formatted: false,
      });

      socket.message({
        type: "Turn",
        turn_order: 7,
        transcript:
          "Augusto è il primo imperatore romano.",
        end_of_turn: true,
        turn_is_formatted: true,
      });

      assert.deepEqual(
        received.filter(
          ([type]) =>
            type === "partial" ||
            type === "complete" ||
            type === "committed",
        ),
        [
          [
            "partial",
            "rt1:7",
            "Augusto è",
          ],
          [
            "partial",
            "rt1:7",
            "Augusto è il primo imperatore romano",
          ],
          [
            "complete",
            "rt1:7",
            "Augusto è il primo imperatore romano.",
          ],
          [
            "committed",
            "rt1:7",
          ],
        ],
      );

      await realtime.stop();

      const controlMessages =
        sent
          .filter(
            (value) =>
              typeof value === "string",
          )
          .map((value) =>
            JSON.parse(value),
          );

      assert.deepEqual(
        controlMessages,
        [
          {
            type: "Terminate",
          },
        ],
      );
    } finally {
      for (
        const key of globalKeys
      ) {
        const descriptor =
          originals[key];

        if (descriptor) {
          Object.defineProperty(
            globalThis,
            key,
            descriptor,
          );
        } else {
          delete globalThis[key];
        }
      }
    }
  },
);
