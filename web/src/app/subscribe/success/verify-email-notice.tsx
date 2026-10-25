import Link from "next/link";

import { lookupAccountVerification } from "~/server/account-verification";
import { auth } from "~/server/auth";

/**
 * A server-rendered notice for a new Premium subscriber whose address is not verified.
 * It is a server component with no client JavaScript: the link goes to /alerts?verify=1,
 * where the send and refresh controls are. It renders nothing for a verified account, an
 * account that signs in another way, or an account that cannot be read.
 */
export async function VerifyEmailNotice() {
  const session = await auth();
  const uid = session?.user?.id;
  if (!uid) return null;

  const account = await lookupAccountVerification(uid);
  if (!account || account.verified || !account.hasPassword) return null;

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm leading-6">
      <p>
        Verify <span className="font-medium">{account.email}</span> to receive
        alert emails. Until it is verified, alerts are recorded but not emailed.
      </p>
      <Link
        href="/alerts?verify=1"
        className="mt-2 inline-block font-medium text-primary underline-offset-4 hover:underline"
      >
        Verify your email
      </Link>
    </div>
  );
}
