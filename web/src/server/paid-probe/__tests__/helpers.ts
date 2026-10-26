// Shared fixtures for the probe's tests. Not a test file itself (jest matches *.test.ts).
import { readFileSync } from "node:fs";
import path from "node:path";

const encoder = new TextEncoder();

/** A recorded fixture, read as text. */
export function fixture(name: string): string {
  return readFileSync(path.join(__dirname, "..", "__fixtures__", name), "utf8");
}

/** A response body that delivers the given text as one or more chunks, then ends. */
export function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/**
 * A body that delivers `prefix` and then fails the way a timed-out fetch does:
 * the reader's next read rejects with a TimeoutError, as it would after our budget fires.
 */
export function cutOffStream(prefix: string): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(prefix));
        return;
      }
      controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    },
  });
}

/** A 200 event-stream response whose body is the given text. */
export function sseResponse(text: string): Response {
  return new Response(streamOf(text), { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
