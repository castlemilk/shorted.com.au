export function Timeline({ children }: { children: React.ReactNode }) {
  return <ol className="my-8 ml-2 space-y-4 border-l border-border pl-6">{children}</ol>;
}

export function TimelineEvent({
  date,
  label,
  cite,
}: {
  date: string;
  label: string;
  cite?: string;
}) {
  return (
    <li className="relative">
      <span
        aria-hidden
        className="absolute -left-[1.85rem] top-1.5 h-2.5 w-2.5 rounded-full border border-primary/60 bg-primary/30"
      />
      <div className="font-mono text-xs text-muted-foreground">{date}</div>
      <div className="text-sm text-foreground">
        {label}
        {cite && <sup className="ml-0.5 text-[10px] text-primary">[{cite}]</sup>}
      </div>
    </li>
  );
}
