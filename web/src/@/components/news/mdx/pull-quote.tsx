export function PullQuote({ children }: { children: React.ReactNode }) {
  return (
    <blockquote className="my-10 border-l-2 border-primary py-2 pl-6 font-serif text-2xl italic leading-snug text-foreground">
      {children}
    </blockquote>
  );
}
