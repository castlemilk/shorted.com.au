import { sb } from "storybook/test";

// Module mocks for widget data dependencies. Must be registered at the top of
// the preview file (Storybook's vite plugin statically rewrites these calls).
// Stories override per-story via `mocked(fn).mockResolvedValue(...)` in
// `beforeEach`. See src/@/mocks/STORY_GUIDE.md for the authoring contract.
// Full mock (src/app/actions/__mocks__/getTopShorts.ts): the real module
// imports kv-cache → ioredis (Node-only), which crashes the browser build.
sb.mock(import("../src/app/actions/getTopShorts"));
sb.mock(import("../src/app/actions/getStock"), { spy: true });
sb.mock(import("../src/@/lib/stock-data-service"), { spy: true });
sb.mock(import("../src/@/lib/client-api"), { spy: true });

import type { Preview, Decorator } from "@storybook/nextjs-vite";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import "../src/styles/globals.css";

// Stable QueryClient per story mount: no retries (errors surface immediately),
// no GC churn, infinite staleTime (fixtures never refetch). Client is created
// once per story mount via useRef so re-renders don't discard the cache
// mid-interaction, which would cause flaky play-function tests.
function QueryClientWrapper({ Story }: { Story: React.ComponentType }) {
  const clientRef = React.useRef<QueryClient | null>(null);
  clientRef.current ??= new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  return (
    <QueryClientProvider client={clientRef.current}>
      <Story />
    </QueryClientProvider>
  );
}

const withQueryClient: Decorator = (Story) => <QueryClientWrapper Story={Story} />;

const withTheme: Decorator = (Story) => (
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
    <Story />
  </ThemeProvider>
);

const preview: Preview = {
  decorators: [withQueryClient, withTheme],
  parameters: {
    layout: "fullscreen",
    backgrounds: { disable: true },
  },
};
export default preview;
