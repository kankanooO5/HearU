class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) {
      const frame = new Float32Array(input);
      this.port.postMessage(frame, [frame.buffer]);
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
