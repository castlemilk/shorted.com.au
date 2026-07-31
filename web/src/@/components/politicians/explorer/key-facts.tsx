import { sectionTitle } from "@/lib/typography";

export interface KeyFact {
  text: string;
  href?: string;
}

export interface KeyFactsProps {
  facts: KeyFact[];
  title?: string;
}

export function KeyFacts({ facts, title = "Key facts" }: KeyFactsProps) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className={sectionTitle}>{title}</h2>
      {facts.length ? (
        <ul className="mt-3 space-y-2 text-sm leading-relaxed">
          {facts.map((fact, index) => (
            <li key={`${fact.text}-${index}`}>
              {fact.href ? (
                <a
                  href={fact.href}
                  className="underline decoration-dotted underline-offset-2 hover:text-primary"
                >
                  {fact.text}
                </a>
              ) : (
                fact.text
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          No key facts are available.
        </p>
      )}
    </section>
  );
}
