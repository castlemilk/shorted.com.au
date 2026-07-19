"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * Directory logo with graceful failure: some `logo_url`s in company metadata
 * 404 on GCS, and a server-rendered <Image> then shows the browser's broken
 * image icon. Swap to the ticker-initials tile on error instead.
 */
export function CompanyLogo({ src, code }: { src: string | null; code: string }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-xs font-semibold text-muted-foreground ring-1 ring-border"
      >
        {code.slice(0, 3)}
      </span>
    );
  }

  return (
    <Image
      src={src}
      alt=""
      width={36}
      height={36}
      sizes="36px"
      className="h-9 w-9 shrink-0 rounded-md bg-white object-contain p-0.5 ring-1 ring-border"
      onError={() => setFailed(true)}
    />
  );
}
