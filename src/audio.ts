export function resample(chunks: Float32Array[], sampleRate: number): Float32Array {
  const size = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const input = new Float32Array(size);
  let at = 0;
  for (const chunk of chunks) { input.set(chunk, at); at += chunk.length; }
  const ratio = sampleRate / 16000;
  const output = new Float32Array(Math.floor(size / ratio));
  for (let i = 0; i < output.length; i++) {
    const position = i * ratio; const left = Math.floor(position); const fraction = position - left;
    output[i] = input[left] * (1 - fraction) + (input[Math.min(left + 1, size - 1)] || 0) * fraction;
  }
  return output;
}
export function recordingType(): string {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}
export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
