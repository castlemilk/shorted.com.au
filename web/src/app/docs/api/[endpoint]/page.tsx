import React from 'react';
import { notFound } from 'next/navigation';
import { parseOpenAPISpec, getEndpoint, getApiBaseUrl } from '~/lib/openapi/parser';
import { EndpointContent } from '~/@/components/docs/endpoint-content';
import { CodePanel } from '~/@/components/docs/code-panel';

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

  // The host the published samples target comes from the generated spec
  // (`servers[0].url`), so the docs cannot drift from the document.
  const baseUrl = await getApiBaseUrl();

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

export async function generateMetadata({ params }: EndpointPageProps) {
  const endpoint = await getEndpoint(params.endpoint);
  if (!endpoint) return {};

  return {
    title: `${endpoint.summary ?? endpoint.path} | Shorted API Documentation`,
    description: endpoint.description ?? `Documentation for the ${endpoint.path} API endpoint.`,
  };
}



