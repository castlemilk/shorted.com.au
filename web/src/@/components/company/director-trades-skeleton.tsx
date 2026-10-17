import { Users } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Skeleton } from "~/@/components/ui/skeleton";

/**
 * The director trades card before its rows have arrived: the title row and
 * five `h-10` rows. It is what DirectorTradesTable draws while its query loads,
 * and what the Company page holds the table's place with until the table's
 * chunk has loaded.
 *
 * Both are the fallback now. The Company page reads the trades on the server
 * and draws DirectorTradesView itself; it hands the section to the table only
 * when that read returned nothing.
 *
 * Its own file, with no "use client" and no Connect import, on purpose. The
 * table queries through Connect-RPC, so a server page can only reach it through
 * `next/dynamic` with `ssr: false`, and with nothing to show until the chunk
 * arrived the page popped a card of about 330px in after load (a first-load
 * layout shift of 0.023 on desktop). A server page can import THIS at no cost
 * and without dragging Connect into a server bundle (ssr-import-safety), so the
 * page passes it as the island's `loading`. The table's own loading branch
 * renders the same component, so the placeholder and the loading state are one
 * footprint and cannot drift apart.
 */
export function DirectorTradesSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Users className="h-5 w-5" />
          Director trades
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
