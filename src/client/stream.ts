/** A client/output budget, independent of the fmsg host's acceptance limits. */
export class ResponseLimitError extends Error {
  constructor(readonly limit: number) { super(`response exceeds the ${limit}-byte client limit`); }
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
