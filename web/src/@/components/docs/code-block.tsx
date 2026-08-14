"use client";

import React, { useEffect, useRef } from "react";
import "prismjs/themes/prism-tomorrow.css";
import { CopyButton } from "./copy-button";

interface CodeBlockProps {
  code: string;
  language: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const Prism = (await import("prismjs")).default;
      // @ts-expect-error -- prism component modules lack type declarations
      await Promise.all([import("prismjs/components/prism-json"), import("prismjs/components/prism-bash"), import("prismjs/components/prism-python"), import("prismjs/components/prism-typescript")]);

      if (!cancelled && codeRef.current) {
        Prism.highlightElement(codeRef.current);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  return (
    <div className="relative group">
      <div className="absolute right-4 top-4 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton value={code} />
      </div>
      <pre
        className={`language-${language} rounded-lg !bg-muted !m-0 p-4 overflow-x-auto text-sm`}
      >
        <code ref={codeRef} className={`language-${language}`}>{code}</code>
      </pre>
    </div>
  );
}
