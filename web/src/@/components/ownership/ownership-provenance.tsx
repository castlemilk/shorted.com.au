import { REPORT_ERROR_EMAIL } from "~/@/lib/report-error";

// Server-safe: no "use client", no Connect import. Where the figures come from
// is part of the composition on this site, not a footnote, so every ownership
// page carries these lines.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// The capture group keeps each date in split()'s output, at the odd indexes.
const DATE_IN_TEXT = /(\d{4}-\d{2}-\d{2})/;

/**
 * Every date in a sentence, set as a <time>; the rest prints as it is. For copy
 * that states its dates inside a sentence, such as a source's range.
 */
export function Dated({ text, timeClassName }: { text: string; timeClassName?: string }) {
  return (
    <>
      {text.split(DATE_IN_TEXT).map((part, index) =>
        index % 2 === 1 ? (
          <time key={index} dateTime={part} className={timeClassName}>
            {part}
          </time>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * The text, with every date it states set as a <time>. A text that states no
 * date is wrapped whole in a <time> when the caller names the date it stands
 * for, so that date is still machine readable; a value that is not a date is
 * printed as text and nothing more.
 */
export function DatedText({
  text,
  dateTime,
  timeClassName,
}: {
  text: string;
  dateTime?: string;
  timeClassName?: string;
}) {
  if (DATE_IN_TEXT.test(text)) return <Dated text={text} timeClassName={timeClassName} />;
  if (dateTime && DATE.test(dateTime)) {
    return (
      <time dateTime={dateTime} className={timeClassName}>
        {text}
      </time>
    );
  }
  return <>{text}</>;
}

const REPORT_LEAD = "Spotted a problem with a figure? ";
const REPORT_TAIL = " and the affected notice will be read again against its PDF.";

/** The report-an-error line every ownership page ends with, addressed by subject. */
export function OwnershipReportError({ subject }: { subject: string }) {
  return (
    <span>
      {REPORT_LEAD}
      <a
        href={`mailto:${REPORT_ERROR_EMAIL}?subject=${encodeURIComponent(subject)}`}
        className="text-primary underline-offset-4 hover:underline"
      >
        Report an error
      </a>
      {REPORT_TAIL}
    </span>
  );
}

export interface SourceLine {
  text: string;
  /** The as-at date, for a line that states no date of its own. */
  asAt?: string;
}

/** Each source a page draws from, with its own date. */
export function OwnershipSourceLines({ lines }: { lines: readonly SourceLine[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {lines.map((line, index) => (
        <li key={index}>
          <DatedText text={line.text} dateTime={line.asAt} />
        </li>
      ))}
    </ul>
  );
}
