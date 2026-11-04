"use client";

import { Suspense, type ComponentType } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * What a URL-driven island is given (spec 13.1): the page's query, its pathname, and
 * one way to write the URL back. The island never reads `location` itself.
 */
export interface UrlState {
  params: URLSearchParams;
  pathname: string;
  navigate: (href: string) => void;
}

const NO_NAVIGATION = () => undefined;

/**
 * Wraps a pure body so it reads the URL under its own Suspense boundary, with the
 * default view (no parameters) as the fallback. The body holds no router and no
 * search-params hook, so a test renders it with plain values; the wrapper is the
 * only place those hooks run. Writing the URL is `router.replace` with no scroll,
 * so a change of view moves the address and nothing else.
 */
export function withUrlState<P extends object>(Body: ComponentType<P & UrlState>): ComponentType<P> {
  function Live(props: P) {
    const search = useSearchParams();
    const pathname = usePathname() ?? "";
    const router = useRouter();
    return (
      <Body
        {...props}
        params={new URLSearchParams(search?.toString() ?? "")}
        pathname={pathname}
        navigate={(href) => router.replace(href, { scroll: false })}
      />
    );
  }
  function Island(props: P) {
    return (
      <Suspense fallback={<Body {...props} params={new URLSearchParams()} pathname="" navigate={NO_NAVIGATION} />}>
        <Live {...props} />
      </Suspense>
    );
  }
  Island.displayName = `UrlState(${Body.displayName ?? Body.name ?? "Body"})`;
  return Island;
}
