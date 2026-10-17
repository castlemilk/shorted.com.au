export function PullQuote({ children }: { children: React.ReactNode }) {
  return (
    <blockquote data-article-figure className="my-10 border-l border-primary/50 py-2 pl-5 font-mono text-xl italic leading-relaxed text-foreground">
      {children}
    </blockquote>
  );
}
