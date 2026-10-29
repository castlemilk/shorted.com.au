import { type Metadata } from "next";

import { EmbedBrandLink } from "./embed-brand-link";

export const metadata: Metadata = {
  robots: "noindex, nofollow",
};

/**
 * Embed layout — strips header, footer, and navigation.
 * Renders only the widget content for iframe embedding.
 */
export default function EmbedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="embed-container" data-embed="true">
      {children}
      <EmbedBrandLink />
    </div>
  );
}
