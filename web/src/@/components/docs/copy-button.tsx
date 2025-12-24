"use client";

import React, { useState } from 'react';
import { Button } from '~/@/components/ui/button';
import { Check, Copy } from 'lucide-react';

interface CopyButtonProps {
  value: string;
}

export function CopyButton({ value }: CopyButtonProps) {
  const [hasCopied, setHasCopied] = useState(false);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setHasCopied(true);
      setTimeout(() => setHasCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  return (
    <Button
      size="icon"
      variant="ghost"
      className="h-8 w-8 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
      onClick={copyToClipboard}
    >
      {hasCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      <span className="sr-only">Copy code</span>
    </Button>
  );
}



