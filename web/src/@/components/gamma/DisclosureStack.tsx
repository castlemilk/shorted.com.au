"use client";

import { useId, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";

export type DisclosureItem = {
  id: string;
  title: string;
  content: ReactNode;
  meta?: string;
};

export type DisclosureStackProps = {
  items: DisclosureItem[];
  mode?: "single" | "multiple";
  defaultOpen?: string[];
  openIds?: string[];
  collapsible?: boolean;
  onOpenChange?: (ids: string[]) => void;
};

/** Accessible disclosure list with single or multiple open panels. */
export function DisclosureStack({
  items,
  mode = "single",
  defaultOpen = [],
  openIds,
  collapsible = true,
  onOpenChange,
}: DisclosureStackProps) {
  const rootId = useId();
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const currentOpen = openIds ?? internalOpen;

  function toggle(id: string) {
    const isOpen = currentOpen.includes(id);
    if (isOpen && mode === "single" && !collapsible) return;
    const next =
      mode === "single"
        ? isOpen
          ? []
          : [id]
        : isOpen
          ? currentOpen.filter((candidate) => candidate !== id)
          : [...currentOpen, id];
    if (openIds === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  }

  return (
    <div className="disclosure-stack">
      {items.map((item, index) => {
        const expanded = currentOpen.includes(item.id);
        const triggerId = `${rootId}-trigger-${index}`;
        const panelId = `${rootId}-panel-${index}`;
        return (
          <section
            className={`disclosure-item ${expanded ? "is-open" : ""}`}
            key={item.id}
          >
            <h3>
              <button
                type="button"
                id={triggerId}
                aria-controls={panelId}
                aria-expanded={expanded}
                onClick={() => toggle(item.id)}
              >
                <span className="disclosure-title">{item.title}</span>
                {item.meta && (
                  <span className="disclosure-meta">{item.meta}</span>
                )}
                <Plus
                  className="disclosure-plus"
                  size={17}
                  aria-hidden="true"
                />
              </button>
            </h3>
            <div
              className="disclosure-panel"
              id={panelId}
              role="region"
              aria-labelledby={triggerId}
              aria-hidden={!expanded}
              inert={!expanded}
            >
              <div className="disclosure-panel-inner">
                <div className="disclosure-content">{item.content}</div>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
