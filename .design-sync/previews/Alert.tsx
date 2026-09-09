import * as React from "react";
import { Alert, AlertTitle, AlertDescription } from "shorted";

/** The canonical form: title + description, `default` variant. */
export const Default = () => (
  <Alert className="max-w-lg">
    <AlertTitle>ASIC data updated</AlertTitle>
    <AlertDescription>
      Short positions for 2,143 ASX products were refreshed from the ASIC report
      dated 5 September 2026.
    </AlertDescription>
  </Alert>
);

/** The `destructive` variant — the second half of the variant axis. */
export const Destructive = () => (
  <Alert variant="destructive" className="max-w-lg">
    <AlertTitle>Sync failed</AlertTitle>
    <AlertDescription>
      The 2:00 AEST ASIC sync did not complete. Short interest for PLS, LTR and
      SYA may be up to 24 hours stale.
    </AlertDescription>
  </Alert>
);

/**
 * A leading `svg` is absolutely positioned by the recipe and the text is
 * inset to clear it (`[&>svg~*]:pl-7`).
 */
export const WithIcon = () => (
  <Alert className="max-w-lg">
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
    <AlertTitle>Reported with a five-day lag</AlertTitle>
    <AlertDescription>
      ASIC publishes short positions four business days after the reporting
      date, so today&apos;s figure describes last week&apos;s book.
    </AlertDescription>
  </Alert>
);

/** Destructive plus icon — the highest-emphasis pairing in the system. */
export const DestructiveWithIcon = () => (
  <Alert variant="destructive" className="max-w-lg">
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
    <AlertTitle>Monthly API quota exhausted</AlertTitle>
    <AlertDescription>
      You have used 1,000 of 1,000 requests this month. Requests will be
      rejected until 1 October, or upgrade for a higher ceiling.
    </AlertDescription>
  </Alert>
);

/** Description only — used for terse inline notices under a chart. */
export const DescriptionOnly = () => (
  <Alert className="max-w-lg">
    <AlertDescription>
      Percentages are of total product in issue, as reported to ASIC, not of
      free float.
    </AlertDescription>
  </Alert>
);
