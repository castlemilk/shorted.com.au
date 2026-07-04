// Dedup state for the `squeeze-alert` command.
//
// Persists the set of stock codes we last alerted on, keyed by an ISO
// timestamp, so we don't re-post the same squeeze every run. Lives in a
// gitignored JSON file alongside the script — the same "local state file"
// convention as the rotated refresh token, and written the same way:
// an atomic temp-file + rename so a crash mid-write can never corrupt it.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, "..", ".squeeze-alerts.json");

// Don't re-alert the same code within this window.
export const DEDUP_WINDOW_MS = 72 * 60 * 60 * 1000; // 72h

interface SqueezeState {
  // stockCode (uppercase) -> ISO timestamp of the last alert posted for it.
  alerts: Record<string, string>;
}

/** Atomic write: temp file in the same dir, then rename over the target. */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function load(): SqueezeState {
  if (!existsSync(STATE_PATH)) return { alerts: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<SqueezeState>;
    return { alerts: parsed.alerts ?? {} };
  } catch {
    // A corrupt state file must never wedge the bot — start clean.
    return { alerts: {} };
  }
}

/**
 * The set of stock codes (uppercase) alerted within the dedup window and so
 * still suppressed. Reads the state file once for the whole run.
 */
export function recentlyAlerted(now = Date.now()): Set<string> {
  const set = new Set<string>();
  for (const [code, ts] of Object.entries(load().alerts)) {
    const when = Date.parse(ts);
    if (!Number.isNaN(when) && now - when < DEDUP_WINDOW_MS) {
      set.add(code.toUpperCase());
    }
  }
  return set;
}

/**
 * Record that `codes` were alerted now, and prune entries that have aged out
 * of the dedup window so the file can't grow unbounded. Atomic write.
 * Only call this after a real (non-dry-run) post.
 */
export function recordAlerted(codes: string[], now = Date.now()): void {
  const state = load();
  const iso = new Date(now).toISOString();
  for (const code of codes) {
    state.alerts[code.toUpperCase()] = iso;
  }
  for (const [code, ts] of Object.entries(state.alerts)) {
    const when = Date.parse(ts);
    if (Number.isNaN(when) || now - when >= DEDUP_WINDOW_MS) {
      delete state.alerts[code];
    }
  }
  atomicWrite(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}
