"use client";

import React, { useEffect } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-python";
import "prismjs/components/prism-typescript";
import "prismjs/themes/prism-tomorrow.css";
import { CopyButton } from "./copy-button";

interface CodeBlockProps {
  code: string;
  language: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  useEffect(() => {
    Prism.highlightAll();
  }, [code, language]);

  return (
    <div className="relative group">
      <div className="absolute right-4 top-4 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton value={code} />
      </div>
      <pre
        className={`language-${language} rounded-lg !bg-muted dark:!bg-zinc-950 !m-0 p-4 overflow-x-auto text-sm`}
      >
        <code className={`language-${language}`}>{code}</code>
      </pre>
    </div>
  );
}
