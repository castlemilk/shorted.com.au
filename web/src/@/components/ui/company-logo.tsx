"use client";

import { useState } from "react";
import Image from "next/image";
import { IdCardIcon } from "@radix-ui/react-icons";
import { normalizedLogoUrl, rawLogoUrl } from "~/@/lib/logo";

interface CompanyLogoProps {
  /** Raw GCS URL (legacy callers). Ignored when stockCode is provided. */
  gcsUrl?: string;
  companyName?: string;
  stockCode: string;
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
}: CompanyLogoProps) {
  // Try normalized → raw → icon, in that order.
  const [stage, setStage] = useState<"normalized" | "raw" | "icon">("normalized");

  const src =
    stage === "normalized"
      ? normalizedLogoUrl(stockCode)
      : stage === "raw"
        ? (gcsUrl ?? rawLogoUrl(stockCode))
        : null;

  if (src === null) {
    return (
      <div className="mr-4">
        <IdCardIcon height={50} width={50} />
      </div>
    );
  }

  return (
    <div className="mr-4 flex-shrink-0">
      <Image
        src={src}
        alt={`${companyName ?? stockCode} logo`}
        width={70}
        height={70}
        className="object-contain"
        onError={() => setStage((s) => (s === "normalized" ? "raw" : "icon"))}
      />
    </div>
  );
}
