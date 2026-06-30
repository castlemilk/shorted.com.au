import UnsubscribeConfirm from "./unsubscribe-confirm";

export const dynamic = "force-dynamic";

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: { t?: string };
}) {
  const token = searchParams.t ?? "";
  return (
    <main className="container mx-auto max-w-xl px-4 py-24 text-center">
      <UnsubscribeConfirm token={token} />
    </main>
  );
}
