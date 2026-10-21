import type { SubstantialNotice } from "~/gen/shorts/v1alpha1/ownership_pb";
import { noticeRow } from "~/@/lib/ownership/rows";
import { NoticeRowsTable } from "./ownership-tables";

// A server component that formats the notices and hands them to the island.
// Its own module so ownership-parts.tsx, which the stock page's Company tab
// imports, reaches no client code.

/**
 * Substantial holding notices, newest first. With a `limit`, the rows past it
 * wait behind "Show all", which names `onRecord` when the API served only the
 * newest of more. The page draws ExternalLinkSymbol, which each notice's ASX
 * link points at.
 */
export function NoticeTable({
  notices,
  showStock = true,
  showHolder = true,
  caption,
  limit,
  onRecord,
}: {
  notices: readonly SubstantialNotice[];
  showStock?: boolean;
  showHolder?: boolean;
  caption: string;
  limit?: number;
  onRecord?: number;
}) {
  if (notices.length === 0) {
    return <p className="text-sm text-muted-foreground">No notices on record.</p>;
  }
  return (
    <NoticeRowsTable
      rows={notices.map((n) => noticeRow(n, showHolder))}
      showStock={showStock}
      showHolder={showHolder}
      caption={caption}
      limit={limit}
      onRecord={onRecord}
    />
  );
}
