"use client";

import { MessageResponse } from "~/@/components/ai-elements/message";

interface ChatMarkdownProps {
  content: string;
}

export function ChatMarkdown({ content }: ChatMarkdownProps) {
  return (
    <MessageResponse
      className="prose prose-sm dark:prose-invert max-w-none break-words
        [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2
        [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground
        [&_code]:rounded [&_code]:bg-background/70 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs
        [&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-bold
        [&_h2]:mb-1 [&_h2]:mt-2.5 [&_h2]:text-sm [&_h2]:font-bold
        [&_h3]:mb-0.5 [&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold
        [&_hr]:my-3 [&_hr]:border-border
        [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:space-y-0.5 [&_ol]:pl-4
        [&_p]:my-1.5 [&_p]:leading-relaxed
        [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-background/70 [&_pre]:p-2
        [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs
        [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1
        [&_th]:border [&_th]:border-border [&_th]:bg-background/70 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium
        [&_ul]:my-1 [&_ul]:list-disc [&_ul]:space-y-0.5 [&_ul]:pl-4"
    >
      {content}
    </MessageResponse>
  );
}
