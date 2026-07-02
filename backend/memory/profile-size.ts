// ponytail: NFR-003 — size guard runs BEFORE the store write, not after.
// The custom error class carries `attemptedBytes` + `maxBytes` so the
// save_memory tool can surface a structured payload (and the model can
// retry with a smaller patch on the next turn).
export class MemorySizeError extends Error {
  readonly attemptedBytes: number;
  readonly maxBytes: number;

  constructor(attemptedBytes: number, maxBytes: number) {
    super(`profile size ${attemptedBytes}B exceeds MEMORY_PROFILE_MAX_BYTES=${maxBytes}B`);
    this.name = "MemorySizeError";
    this.attemptedBytes = attemptedBytes;
    this.maxBytes = maxBytes;
  }
}

export function assertProfileSize(value: Record<string, unknown>, maxBytes: number): void {
  const bytes = JSON.stringify(value).length;
  if (bytes > maxBytes) {
    throw new MemorySizeError(bytes, maxBytes);
  }
}
