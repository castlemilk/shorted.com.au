import { type Metadata } from "next";

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
      <div className="fixed bottom-1 right-2 z-50">
        <a
          href="https://shorted.com.au"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        >
          shorted.com.au
        </a>
      </div>
    </div>
  );
}
