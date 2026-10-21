import React from "react";
import { ApiSidebar } from "~/@/components/docs/api-sidebar";
import { ApiHeader } from "~/@/components/docs/api-header";
import {
  toApiNavGroups,
  toApiSearchEndpoint,
} from "~/@/components/docs/api-nav";
import { parseOpenAPISpec } from "~/lib/openapi/parser";

export default async function ApiDocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const spec = await parseOpenAPISpec();

  // Both components are client components: pass them only the fields they
  // render, never the parsed schemas (see api-nav.ts).
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <ApiHeader endpoints={spec.endpoints.map(toApiSearchEndpoint)} />
      <div className="container flex-1 items-start md:grid md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="fixed top-14 z-30 -ml-2 hidden h-[calc(100vh-3.5rem)] w-full shrink-0 md:sticky md:block border-r border-border">
          <ApiSidebar groups={toApiNavGroups(spec.groups)} />
        </aside>
        <main className="relative min-h-screen">{children}</main>
      </div>
    </div>
  );
}
