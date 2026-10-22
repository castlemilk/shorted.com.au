import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { parseOpenAPISpec, getEndpoint, getApiBaseUrl } from '~/lib/openapi/parser';
import { EndpointContent } from '~/@/components/docs/endpoint-content';
import { CodePanel } from '~/@/components/docs/code-panel';
import { siteConfig } from '~/@/config/site';
import { apiDocsMetadata, descriptionSnippet, endpointTitle } from '../docs-metadata';

interface EndpointPageProps {
  params: {
    endpoint: string;
  };
}

export async function generateStaticParams() {
  const spec = await parseOpenAPISpec();
  return spec.endpoints.map((endpoint) => ({
    endpoint: endpoint.id,
  }));
}

export default async function EndpointPage({ params }: EndpointPageProps) {
  const endpoint = await getEndpoint(params.endpoint);

  if (!endpoint) {
    return notFound();
  }

  // The host the published samples target comes from the generated spec, so
  // the docs cannot drift from the document: the endpoint's own `servers`
  // when its path declares one (/api/search/stocks and /feed.xml are served by
  // the web app, not the API host), else the document's `servers[0].url`.
  const baseUrl = endpoint.servers?.[0]?.url ?? (await getApiBaseUrl());

  return (
    <div className="xl:grid xl:grid-cols-[1fr_400px] gap-0">
      <div className="px-4 py-6 md:px-8">
        <EndpointContent endpoint={endpoint} />
      </div>
      <div className="hidden xl:block">
        <div className="sticky top-14 h-[calc(100vh-3.5rem)]">
          <CodePanel endpoint={endpoint} baseUrl={baseUrl} />
        </div>
      </div>
      {/* Mobile Code Panel (shows at bottom) */}
      <div className="xl:hidden px-4 md:px-8 py-8 border-t border-border">
        <CodePanel endpoint={endpoint} baseUrl={baseUrl} />
      </div>
    </div>
  );
}

export async function generateMetadata({ params }: EndpointPageProps): Promise<Metadata> {
  const endpoint = await getEndpoint(params.endpoint);
  if (!endpoint) return {};

  return apiDocsMetadata({
    title: endpointTitle(endpoint),
    description:
      descriptionSnippet(endpoint.description ?? '') ||
      `Documentation for the ${endpoint.path} API endpoint.`,
    canonical: `${siteConfig.url}/docs/api/${endpoint.id}`,
  });
}



