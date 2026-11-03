/**
 * How a notice's event reads on the page. The API decides the event once, from
 * a notice's form and figures (SubstantialNotice.event), and this module only
 * names it. It never looks at the form or the figures, so the feed and the API
 * cannot disagree about what a notice was.
 */

import { isNoticeEvent, type NoticeEvent } from "./query";

/**
 * What each event says, in the words a cell or an option prints: sentence case,
 * one capital and then lower case, with NZ the one acronym. A label used
 * mid-sentence takes lower case. A fall is reported as a fall in the notice's own
 * figure: the label names the change and nothing the notice does not state.
 */
export const NOTICE_EVENT_LABELS: Readonly<Record<NoticeEvent, string>> = {
  became: "Became substantial",
  increased: "Increased",
  decreased: "Decreased",
  changed: "Changed",
  ceased: "Ceased",
  nz: "NZ disclosure",
};

/**
 * The label of a notice's event. An empty event prints "n/a", and an event this
 * build does not know prints as the API sent it, never as a guess.
 */
export function noticeEventLabel(event: string): string {
  if (event === "") return "n/a";
  return isNoticeEvent(event) ? NOTICE_EVENT_LABELS[event] : event;
}
