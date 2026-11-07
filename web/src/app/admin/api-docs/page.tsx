import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "~/server/admin";
import { PRIVATE_DOCS } from "~/server/private-docs/docs.generated";
import Container from "@/components/ui/container";
import { PrivateDocViewer } from "./private-doc-viewer";

// The private API docs: behind the admin login (the /admin middleware and
// requireAdmin below), rendered per request and never cached, indexed or
// linked from a public page. The documents live in server code
// (src/server/private-docs), never under public/, so no static URL serves them.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Private API docs",
  robots: { index: false, follow: false },
};

export default async function PrivateApiDocsPage() {
  await requireAdmin();

  return (
    <Container>
      <div className="space-y-6 py-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Private API docs</h1>
          <p className="mt-1 max-w-3xl text-muted-foreground">
            The parts of the Shorted API that need a credential, for administrators only. Copy a document
            as markdown to hand it to a workflow or a tool. The public reference is at{" "}
            <Link href="/docs/api" prefetch={false} className="text-primary hover:underline">
              /docs/api
            </Link>
            ; market-moves tokens are made at{" "}
            <Link href="/admin/market-moves" prefetch={false} className="text-primary hover:underline">
              /admin/market-moves
            </Link>
            .
          </p>
          <nav aria-label="Documents" className="mt-3 flex flex-wrap gap-3 text-sm">
            {PRIVATE_DOCS.map((doc) => (
              <a key={doc.slug} href={`#${doc.slug}`} className="text-primary hover:underline">
                {doc.title}
              </a>
            ))}
          </nav>
        </div>
        {PRIVATE_DOCS.map((doc) => (
          <PrivateDocViewer
            key={doc.slug}
            slug={doc.slug}
            title={doc.title}
            description={doc.description}
            markdown={doc.markdown}
          />
        ))}
      </div>
    </Container>
  );
}
