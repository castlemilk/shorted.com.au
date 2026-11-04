"use client";

import { useEffect, useId, useRef, useState, type HTMLAttributes } from "react";
import { ChevronDown, Plus, X } from "lucide-react";

export type FilterOption = {
  value: string;
  label: string;
  count?: number;
};

export type FilterGroup = {
  id: string;
  label: string;
  options: FilterOption[];
};

export type FilterValue = Record<string, string[]>;

export type FilterBarProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "onChange" | "defaultValue"
> & {
  groups: FilterGroup[];
  value?: FilterValue;
  defaultValue?: FilterValue;
  onValueChange?: (value: FilterValue) => void;
  label?: string;
  clearLabel?: string;
  emptyLabel?: string;
};

function selectedIn(value: FilterValue, group: string) {
  return value[group] ?? [];
}

/**
 * A filter builder: grouped checkboxes live in one compact panel, active
 * filters become removable chips, and the count updates in a live region.
 * Removing a chip returns focus to the filter trigger.
 */
export function FilterBar({
  groups,
  value,
  defaultValue = {},
  onValueChange,
  label = "Filters",
  clearLabel = "Clear all",
  emptyLabel = "No filters applied",
  className = "",
  ...props
}: FilterBarProps) {
  const id = useId();
  const [internalValue, setInternalValue] = useState<FilterValue>(defaultValue);
  const [open, setOpen] = useState(false);
  const current = value ?? internalValue;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const active = groups.flatMap((group) =>
    selectedIn(current, group.id).flatMap((selected) => {
      const option = group.options.find((item) => item.value === selected);
      return option ? [{ group, option }] : [];
    }),
  );

  function update(next: FilterValue) {
    if (value === undefined) setInternalValue(next);
    onValueChange?.(next);
  }

  function toggle(group: FilterGroup, option: FilterOption) {
    const selected = new Set(selectedIn(current, group.id));
    if (selected.has(option.value)) selected.delete(option.value);
    else selected.add(option.value);
    const next = { ...current };
    if (selected.size) next[group.id] = [...selected];
    else delete next[group.id];
    update(next);
  }

  function remove(group: FilterGroup, option: FilterOption) {
    const selected = selectedIn(current, group.id).filter(
      (item) => item !== option.value,
    );
    const next = { ...current };
    if (selected.length) next[group.id] = selected;
    else delete next[group.id];
    update(next);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function clear() {
    update({});
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div {...props} ref={rootRef} className={`filter-bar ${className}`}>
      <div className="filter-bar-head">
        <span className="filter-bar-title">
          {label}{" "}
          <strong aria-live="polite" aria-atomic="true">
            {active.length}
          </strong>
        </span>
        {active.length > 0 && (
          <button type="button" className="filter-bar-clear" onClick={clear}>
            {clearLabel}
          </button>
        )}
      </div>
      <div className="filter-bar-controls">
        <div className="filter-bar-popover">
          <button
            ref={triggerRef}
            type="button"
            className="filter-bar-trigger"
            aria-expanded={open}
            aria-controls={`${id}-panel`}
            onClick={() => setOpen((currentOpen) => !currentOpen)}
          >
            <Plus size={14} aria-hidden="true" />
            Add filter
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          {open && (
            <div
              className="filter-bar-panel"
              id={`${id}-panel`}
              role="group"
              aria-label="Filter options"
            >
              {groups.map((group) => (
                <fieldset className="filter-bar-group" key={group.id}>
                  <legend>{group.label}</legend>
                  <ul>
                    {group.options.map((option) => {
                      const checked = selectedIn(current, group.id).includes(
                        option.value,
                      );
                      return (
                        <li key={option.value}>
                          <label data-checked={checked || undefined}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggle(group, option)}
                            />
                            <span>{option.label}</span>
                            {option.count !== undefined && (
                              <small>{option.count}</small>
                            )}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              ))}
            </div>
          )}
        </div>
        <ul className="filter-bar-chips" aria-label="Active filters">
          {active.length ? (
            active.map(({ group, option }) => (
              <li key={`${group.id}:${option.value}`}>
                <span>
                  <small>{group.label}</small>
                  {option.label}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${group.label}: ${option.label}`}
                  onClick={() => remove(group, option)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            ))
          ) : (
            <li className="filter-bar-empty">{emptyLabel}</li>
          )}
        </ul>
      </div>
    </div>
  );
}
