/**
 * The window of change as one labelled select (spec 14.9): the Overview's toolbar (backlog B2 replaced its
 * chips), the map, connections, activity and the notices feed share it. It writes the same `window` link the chips wrote, and
 * a brushed pair (`since`/`until`) is one extra option, "Brushed" (the dates are the caption's, so the
 * select keeps its width).
 *
 * A PLAIN MODULE: the server's default view draws it disabled (no handler), and an island passes
 * `onWindowChange`, which writes the link in place. The in-place write is the one the instruments
 * already use (replaceState, which useSearchParams observes), so no request is made by the select itself.
 */

import { DESK_WINDOWS, writeNoticeWindow, type DeskWindow, type NoticeWindow } from "../desk/desk-state";
import { ToolbarSelect } from "./toolbar";

/** A window option's visible text: "91 days". */
export function windowOptionLabel(days: DeskWindow): string {
  return `${days} days`;
}

/**
 * Writes a window into the current link in place, keeping every other parameter. The one setter the
 * window select and the instruments share.
 */
export function writeWindowInPlace(next: NoticeWindow): void {
  const writer = new URLSearchParams(window.location.search);
  writeNoticeWindow(writer, next);
  const url = new URL(window.location.href);
  url.search = writer.toString();
  window.history.replaceState(null, "", url);
}

export interface WindowSelectProps {
  /** The visible label. */
  label?: string;
  /** The window the page is showing; a brushed window adds one option that names it. */
  active: NoticeWindow;
  /** Called with the chosen window. Absent on the server's default view, where the select is drawn disabled. */
  onWindowChange?: (next: NoticeWindow) => void;
}

export function WindowSelect({ label = "Window", active, onWindowChange }: WindowSelectProps) {
  const brushed = active.since !== "";
  return (
    <ToolbarSelect
      label={label}
      value={brushed ? "brushed" : String(active.window)}
      onChange={
        onWindowChange === undefined
          ? undefined
          : (value) => {
              if (value === "brushed") return;
              onWindowChange({ window: Number(value) as DeskWindow, since: "", until: "" });
            }
      }
    >
      {brushed ? <option value="brushed">Brushed</option> : null}
      {DESK_WINDOWS.map((days) => (
        <option key={days} value={String(days)}>
          {windowOptionLabel(days)}
        </option>
      ))}
    </ToolbarSelect>
  );
}
