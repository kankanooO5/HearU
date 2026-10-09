class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const requested =
      options?.processorOptions
        ?.frameSamples;

    this.frameSamples =
      Number.isFinite(requested) &&
      requested > 0
        ? Math.floor(requested)
        : 800;

    this.frame =
      new Float32Array(
        this.frameSamples
      );

    this.frameLength = 0;
  }

  process(inputs) {
    const channels =
      inputs[0];

    if (
      !channels ||
      channels.length === 0 ||
      !channels[0]
    ) {
      return true;
    }

    const input =
      channels[0];

    for (
      let i = 0;
      i < input.length;
      i++
    ) {
      this.frame[
        this.frameLength++
      ] = input[i];

      if (
        this.frameLength ===
        this.frameSamples
      ) {
        const output =
          this.frame;

        this.port.postMessage(
          output,
          [output.buffer],
        );

        this.frame =
          new Float32Array(
            this.frameSamples
          );

        this.frameLength = 0;
      }
    }

    return true;
  }
}

registerProcessor(
  "capture-processor",
  CaptureProcessor
);
