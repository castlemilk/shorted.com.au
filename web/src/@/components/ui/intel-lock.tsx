import Link from "next/link";
import { Lock } from "lucide-react";
import { cn } from "~/@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";

/**
 * High-visibility yellow sign-in CTA used on intel lock states. Distinct from
 * the amber primary so "sign in to unlock" reads as its own action.
 */
export function YellowSignInButton({
  callbackUrl,
  children = "Sign in to unlock",
  className,
}: {
  callbackUrl: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={`/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`}
      className={cn(
        "inline-flex h-10 items-center justify-center gap-2 rounded-md px-4",
        "bg-yellow-400 text-sm font-semibold text-yellow-950",
        "hover:bg-yellow-300 dark:bg-yellow-500 dark:hover:bg-yellow-400",
        "transition-colors focus-visible:outline-none focus-visible:ring-2",
        "focus-visible:ring-yellow-500 focus-visible:ring-offset-2",
        className,
      )}
    >
      <Lock className="h-4 w-4" aria-hidden />
      {children}
    </Link>
  );
}

/**
 * Locked-content teaser: shown to signed-out visitors where intelligence
 * content lives. Names what's behind the lock and routes to sign-in with a
 * return path.
 */
export function IntelLockCard({
  title,
  description,
  bullets,
  callbackUrl,
  ctaLabel = "Sign in to unlock",
}: {
  title: string;
  description: string;
  bullets?: string[];
  callbackUrl: string;
  ctaLabel?: string;
}) {
  return (
    <Card className="border-yellow-300/60 dark:border-yellow-700/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300">
            <Lock className="h-4 w-4" aria-hidden />
          </span>
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {bullets && bullets.length > 0 && (
          <ul className="grid gap-1.5 text-sm text-muted-foreground sm:grid-cols-2">
            {bullets.map((bullet) => (
              <li key={bullet} className="flex items-start gap-2">
                <span
                  aria-hidden
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-yellow-500"
                />
                {bullet}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <YellowSignInButton callbackUrl={callbackUrl}>
            {ctaLabel}
          </YellowSignInButton>
          <span className="text-xs text-muted-foreground">
            Free account · no card required
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
