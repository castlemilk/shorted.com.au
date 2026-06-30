import { unsubscribe } from "~/app/actions/unsubscribe";

export const dynamic = "force-dynamic";

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: { t?: string };
}) {
  const token = searchParams.t ?? "";
  const ok = token ? await unsubscribe(token) : false;
  return (
    <main className="container mx-auto max-w-xl px-4 py-24 text-center">
      <h1 className="text-2xl font-bold text-foreground">
        {ok ? "You've been unsubscribed" : "Unsubscribe"}
      </h1>
      <p className="mt-4 text-muted-foreground">
        {ok
          ? "You won't receive any more newsletter emails from Shorted. You can resubscribe any time from the site."
          : "This unsubscribe link is invalid or has expired. If you keep receiving emails, contact support@shorted.com.au."}
      </p>
      <a href="/" className="mt-8 inline-block text-primary hover:underline">
        Return to Shorted →
      </a>
    </main>
  );
}
