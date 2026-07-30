"use client";

import dynamic from "next/dynamic";

// Keeps politicians_pb in its own async chunk rather than the hot
// /housing/[state]/[suburb] route bundle.
export const SuburbPoliticianPropertyCard = dynamic<{ salCode: string }>(
  () =>
    import("./suburb-politician-property-card").then((m) => m.SuburbPoliticianPropertyCard),
  { ssr: false },
);
