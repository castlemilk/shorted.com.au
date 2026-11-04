"use client";

import { useId, useState, type HTMLAttributes, type ReactNode } from "react";

export type SegmentedControlOption = {
  /** Stable value reported to onChange. */
  value: string;
  /** Visible label. Keep it to one or two words. */
  label: ReactNode;
  /** Decorative glyph shown before the label. */
  icon?: ReactNode;
  /** Count shown after the label. The number is informational, not a choice. */
  count?: number;
  /** A disabled option cannot be selected. */
  disabled?: boolean;
  /** Extra context for assistive technology when the visible label is short. */
  description?: string;
  /** A tooltip on the option for a sighted pointer reader (spec 14.8: why a disabled option is disabled). */
  title?: string;
  /** Accessible name for an option whose visible label is an icon alone. */
  ariaLabel?: string;
};

export type SegmentedControlProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "onChange" | "defaultValue"
> & {
  /** Accessible name for the group of options. */
  label: string;
  /** The options, in reading order. */
  options: SegmentedControlOption[];
  /** Selected value. Pair with onChange for controlled use. */
  value?: string;
  /** Initially selected value for uncontrolled use. */
  defaultValue?: string;
  /** Called with the newly selected value. */
  onChange?: (value: string) => void;
  /** Control density. */
  size?: "sm" | "md";
  /** Give every option an equal share of the row width. */
  block?: boolean;
  /** Lay the options out in a row or a column. */
  orientation?: "horizontal" | "vertical";
};

/**
 * One exclusive choice from a short row of options.
 *
 * The row is a native radio group, so arrow keys, Home and End move between
 * options and the browser keeps the checked state. Selection is announced by
 * the option's own label; counts and icons are supplementary.
 *
 * Conventions: native semantics first, every value from a --gamma-* token,
 * visible focus, and a reduced-motion rule in library.css for any animation.
 */
export function SegmentedControl({
  label,
  options,
  value,
  defaultValue,
  onChange,
  size = "md",
  block = false,
  orientation = "horizontal",
  className = "",
  ...props
}: SegmentedControlProps) {
  const group = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [uncontrolled, setUncontrolled] = useState(
    defaultValue ?? options.find((option) => !option.disabled)?.value ?? "",
  );
  const selected = value ?? uncontrolled;

  function select(next: string) {
    if (next === selected) return;
    if (value === undefined) setUncontrolled(next);
    onChange?.(next);
  }

  return (
    <div
      {...props}
      role="radiogroup"
      aria-label={label}
      className={`segmented-control ${className}`.trim()}
      data-size={size}
      data-block={block ? "true" : undefined}
      data-orientation={orientation}
    >
      {options.map((option) => {
        const active = option.value === selected;
        return (
          <label
            key={option.value}
            className="segmented-control-option"
            data-active={active ? "true" : undefined}
            title={option.title}
          >
            <input
              className="segmented-control-input"
              type="radio"
              name={group}
              value={option.value}
              checked={active}
              disabled={option.disabled}
              onChange={() => select(option.value)}
              aria-describedby={
                option.description ? `${group}-${option.value}` : undefined
              }
              aria-label={option.ariaLabel}
            />
            <span className="segmented-control-face">
              {option.icon && (
                <span className="segmented-control-icon" aria-hidden="true">
                  {option.icon}
                </span>
              )}
              <span className="segmented-control-label">{option.label}</span>
              {option.count !== undefined && (
                <span className="segmented-control-count">{option.count}</span>
              )}
            </span>
            {option.description && (
              <span
                id={`${group}-${option.value}`}
                className="segmented-control-description"
              >
                {option.description}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}
