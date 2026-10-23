let running = false;

/**
 * Run `task` unless a probe is already in flight on this instance. A second
 * trigger would double the chat sends against the probe user's daily and monthly
 * caps and interleave two conversations, so it is refused with a 409 instead.
 * This is per instance: concurrent instances are not coordinated.
 */
export async function runIfIdle<T>(
  task: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (running) return { ran: false };
  running = true;
  try {
    return { ran: true, value: await task() };
  } finally {
    running = false;
  }
}
