"use client";

import { useState, type HTMLAttributes } from "react";
import { ChevronUp } from "lucide-react";

export type AvatarPresence = "online" | "away" | "busy" | "offline";

export type AvatarPerson = {
  id: string;
  name: string;
  /** An image URL or a consumer-owned image element is not required; initials are the fallback. */
  src?: string;
  presence?: AvatarPresence;
};

export type AvatarGroupProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> & {
  people: AvatarPerson[];
  /** Number of avatars visible before the overflow control. */
  max?: number;
  size?: "sm" | "md" | "lg";
  label?: string;
  /** Allows the overflow control to reveal the full roster. */
  expandable?: boolean;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function AvatarPortrait({
  person,
  tone,
}: {
  person: AvatarPerson;
  tone: number;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <span className="avatar-group-avatar" data-tone={tone}>
      {person.src && !imageFailed ? (
        // Avatar URLs are consumer-owned; the component has no Next image loader.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={person.src}
          alt=""
          aria-hidden="true"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initials(person.name)}</span>
      )}
      {person.presence && (
        <span
          className="avatar-group-presence"
          data-presence={person.presence}
          aria-hidden="true"
        />
      )}
      <span className="avatar-group-sr">
        {person.name}
        {person.presence ? `, ${presenceLabel[person.presence]}` : ""}
      </span>
    </span>
  );
}

const presenceLabel: Record<AvatarPresence, string> = {
  online: "Online",
  away: "Away",
  busy: "Busy",
  offline: "Offline",
};

/**
 * An overlapping people stack. Presence dots have text equivalents, the
 * overflow control exposes the hidden count, and expanding the group relaxes
 * the overlap into a readable roster without changing the data.
 */
export function AvatarGroup({
  people,
  max = 4,
  size = "md",
  label = "People",
  expandable = true,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  className = "",
  ...props
}: AvatarGroupProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const isExpanded = expanded ?? internalExpanded;
  const visibleMax = Math.max(1, Math.min(max, people.length));
  const visible = isExpanded ? people : people.slice(0, visibleMax);
  const hiddenCount = Math.max(0, people.length - visibleMax);
  const canExpand = expandable && hiddenCount > 0;

  function toggle() {
    const next = !isExpanded;
    if (expanded === undefined) setInternalExpanded(next);
    onExpandedChange?.(next);
  }

  if (!people.length) {
    return (
      <div {...props} className={`avatar-group ${className}`}>
        <span className="avatar-group-empty">No people to show.</span>
      </div>
    );
  }

  return (
    <div {...props} className={`avatar-group ${className}`} data-size={size}>
      <ul
        className="avatar-group-list"
        data-expanded={isExpanded || undefined}
        aria-label={label}
      >
        {visible.map((person, index) => (
          <li key={person.id} className="avatar-group-person">
            <AvatarPortrait person={person} tone={index % 4} />
          </li>
        ))}
        {hiddenCount > 0 && !isExpanded && (
          <li className="avatar-group-overflow">
            {canExpand ? (
              <button
                type="button"
                aria-expanded="false"
                aria-label={`Show ${hiddenCount} more people`}
                onClick={toggle}
              >
                +{hiddenCount}
              </button>
            ) : (
              <span>+{hiddenCount}</span>
            )}
          </li>
        )}
        {canExpand && isExpanded && (
          <li className="avatar-group-overflow avatar-group-collapse">
            <button
              type="button"
              aria-expanded="true"
              aria-label="Show fewer people"
              onClick={toggle}
            >
              <ChevronUp size={15} aria-hidden="true" />
              Fewer
            </button>
          </li>
        )}
      </ul>
      <span className="avatar-group-sr">
        {people.length} people.{" "}
        {hiddenCount && !isExpanded ? `${hiddenCount} hidden.` : "All shown."}
      </span>
    </div>
  );
}
