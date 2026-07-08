"use client";

import { useState } from "react";
import Image from "next/image";
import { IdCardIcon } from "@radix-ui/react-icons";
import { normalizedLogoUrl, rawLogoUrl } from "~/@/lib/logo";
import { cn } from "~/@/lib/utils";

interface CompanyLogoProps {
  /** Raw GCS URL (legacy callers). Ignored when stockCode is provided. */
  gcsUrl?: string;
  companyName?: string;
  stockCode: string;
  size?: number;
  className?: string;
  imageClassName?: string;
}

/**
 * Renders the normalized (trimmed + centred 256×256) logo when present;
 * gracefully falls back to the raw source logo, then to an icon, when
 * the normalized version is missing or the source 404s.
 */
export function CompanyLogo({
  gcsUrl,
  companyName,
  stockCode,
  size = 70,
  className,
  imageClassName,
}: CompanyLogoProps) {
  // Try normalized → raw → icon, in that order.
  const [stage, setStage] = useState<"normalized" | "raw" | "icon">(
    "normalized",
  );

  const src =
    stage === "normalized"
      ? normalizedLogoUrl(stockCode)
      : stage === "raw"
        ? (gcsUrl ?? rawLogoUrl(stockCode))
        : null;

  if (src === null) {
    return (
      <div className={cn("flex-shrink-0", className ?? "mr-4")}>
        <IdCardIcon height={size} width={size} />
      </div>
    );
  }

  return (
    <div className={cn("flex-shrink-0", className ?? "mr-4")}>
      <Image
        src={src}
        alt={`${companyName ?? stockCode} logo`}
        width={size}
        height={size}
        className={cn("object-contain", imageClassName)}
        onError={() => setStage((s) => (s === "normalized" ? "raw" : "icon"))}
      />
    </div>
  );
}
