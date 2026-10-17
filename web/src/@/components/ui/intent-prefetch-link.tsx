"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, type ComponentPropsWithoutRef } from "react";

type IntentPrefetchLinkProps = Omit<ComponentPropsWithoutRef<typeof Link>, "href" | "prefetch"> & {
  href: string;
};

const INTENT_DELAY_MS = 150;

/** Warm a page after deliberate hover or focus, without fetching every visible link. */
export function IntentPrefetchLink({
  href,
  children,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  ...props
}: IntentPrefetchLinkProps) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef(false);
  const focused = useRef(false);
  const prefetchedHref = useRef<string | null>(null);

  const cancel = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const schedule = () => {
    if (timer.current !== null || prefetchedHref.current === href) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      prefetchedHref.current = href;
      router.prefetch(href);
    }, INTENT_DELAY_MS);
  };

  useEffect(() => () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    hovered.current = false;
    focused.current = false;
  }, [href]);

  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        if (event.defaultPrevented || event.pointerType === "touch") return;
        hovered.current = true;
        schedule();
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        hovered.current = false;
        if (!focused.current) cancel();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        if (event.defaultPrevented) return;
        focused.current = true;
        schedule();
      }}
      onBlur={(event) => {
        onBlur?.(event);
        focused.current = false;
        if (!hovered.current) cancel();
      }}
    >
      {children}
    </Link>
  );
}
