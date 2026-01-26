"use client";

import { useState } from "react";
import { IdCardIcon } from "@radix-ui/react-icons";

interface CompanyLogoProps {
  gcsUrl?: string;
  companyName?: string;
  stockCode: string;
}

export function CompanyLogo({
  gcsUrl,
  companyName,
  stockCode,
}: CompanyLogoProps) {
  const [imageError, setImageError] = useState(false);

  if (!gcsUrl || imageError) {
    return (
      <div className="mr-4">
        <IdCardIcon height={50} width={50} />
      </div>
    );
  }

  return (
    <div className="mr-4 flex-shrink-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={gcsUrl}
        alt={`${companyName ?? stockCode} logo`}
        width={70}
        height={70}
        className="object-contain"
        onError={() => setImageError(true)}
      />
    </div>
  );
}
