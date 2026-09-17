/** A client/output budget, independent of the fmsg host's acceptance limits. */
export class ResponseLimitError extends Error {
  constructor(readonly limit: number) { super(`response exceeds the ${limit}-byte client limit`); }
}

/** Budget time awaiting the next chunk, not the duration of a progressing download. */
export function withIdleTimeout(stream: ReadableStream<Uint8Array>, timeoutMs: number): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const cancel = async (reason?: unknown) => {
    stopped = true;
    clearTimeout(timer);
    try { await reader.cancel(reason); }
    finally { reader.releaseLock(); }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      timer = setTimeout(() => {
        const error = new DOMException("attachment download stalled waiting for data", "TimeoutError");
        controller.error(error);
        void cancel(error).catch(() => undefined);
      }, timeoutMs).unref();
      try {
        const { done, value } = await reader.read();
        if (stopped) return;
        if (done) {
          stopped = true;
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          reader.releaseLock();
          controller.error(error);
        }
      } finally { clearTimeout(timer); }
    },
    cancel,
  });
}

/** Stop reading at a byte budget, optionally returning a marked preview. */
export async function readBytes(stream: ReadableStream<Uint8Array> | null, limit = Infinity, preview = false): Promise<{ data: Uint8Array; truncated: boolean }> {
  if (!stream) return { data: new Uint8Array(), truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { data: Buffer.concat(chunks, size), truncated: false };
      if (size + value.byteLength > limit) {
        if (!preview) throw new ResponseLimitError(limit);
        chunks.push(value.subarray(0, limit - size));
        return { data: Buffer.concat(chunks, limit), truncated: true };
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
