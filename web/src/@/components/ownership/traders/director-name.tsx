import Link from "next/link";
import {
  ASX_CODE,
  directorHref,
  isNamedDirectorTrade,
} from "~/@/lib/ownership/traders";

export function DirectorName({
  trade,
}: {
  trade: {
    stockCode: string;
    directorName: string;
    sharesTraded?: bigint | number;
  };
}) {
  if (!ASX_CODE.test(trade.stockCode) || !isNamedDirectorTrade(trade))
    return <>{trade.directorName}</>;
  return (
    <Link
      href={directorHref(trade.stockCode, trade.directorName)}
      prefetch={false}
      className="text-primary underline-offset-4 hover:underline"
    >
      {trade.directorName}
    </Link>
  );
}
