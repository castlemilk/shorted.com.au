import Link from "next/link";
import { KeyRound } from "lucide-react";
import { requireAdmin } from "~/server/admin";
import { listMarketMovesTokens } from "~/app/actions/admin/marketMovesTokens";
import { MarketMovesTokensClient } from "./tokens-client";
import Container from "@/components/ui/container";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const dynamic = "force-dynamic";

// The public API origin a workflow posts to. The server actions talk to the
// direct service origin; the example shows the address a workflow outside our
// infrastructure uses.
const PUBLIC_API_ORIGIN = "https://api.shorted.com.au";

export default async function MarketMovesAdminPage() {
  await requireAdmin();
  const list = await listMarketMovesTokens();

  return (
    <Container>
      <div className="space-y-6 py-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Market moves</h1>
          <p className="mt-1 text-muted-foreground">
            Tokens for the workflow that posts market moves to{" "}
            <Link href="/market-moves" prefetch={false} className="text-primary hover:underline">
              /market-moves
            </Link>
            . A post is live at once. The posting API, ready to copy for the workflow, is in the{" "}
            <Link href="/admin/api-docs#market-moves" prefetch={false} className="text-primary hover:underline">
              private API docs
            </Link>
            .
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" aria-hidden />
              Posting tokens
            </CardTitle>
            <CardDescription>
              A token can post and retract market moves and nothing else. It is shown once when it is
              created; revoking it stops it everywhere within 30 seconds. Each move records the token that
              posted it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MarketMovesTokensClient
              initial={list.tokens}
              maxActive={list.maxActive}
              apiOrigin={PUBLIC_API_ORIGIN}
              loadError={list.ok ? undefined : list.error}
            />
          </CardContent>
        </Card>
      </div>
    </Container>
  );
}
