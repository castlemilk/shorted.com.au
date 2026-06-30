import { requireAdmin } from "~/server/admin";
import { getBroadcasts } from "~/app/actions/getBroadcasts";
import { BroadcastsClient } from "./broadcasts-client";
import Container from "@/components/ui/container";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Mail } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function BroadcastsPage() {
  await requireAdmin();
  const broadcasts = await getBroadcasts();

  return (
    <Container>
      <div className="space-y-6 py-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Broadcasts</h1>
          <p className="text-muted-foreground mt-1">
            Review and send email broadcasts to active subscribers.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              All Broadcasts
            </CardTitle>
            <CardDescription>
              Broadcasts with status <strong>draft</strong> or <strong>failed</strong> can be
              sent. Sending dispatches to all active subscribers via Resend.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BroadcastsClient initial={broadcasts} />
          </CardContent>
        </Card>
      </div>
    </Container>
  );
}
