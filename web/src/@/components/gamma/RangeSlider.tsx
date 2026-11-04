"use client";

import {
  useId,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
} from "react";

export type RangeSliderProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  | "type"
  | "value"
  | "defaultValue"
  | "onChange"
  | "min"
  | "max"
  | "step"
  | "children"
  | "size"
> & {
  label: string;
  description?: string;
  value?: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number | "any";
  onChange?: (value: number) => void;
  formatValue?: (value: number) => string;
  /** Control density. Compact hides the min and max bounds. */
  size?: "sm" | "md";
};

/** A native range control with a visible, formatted numeric value. */
export function RangeSlider({
  label,
  description,
  value,
  defaultValue,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  formatValue = String,
  size = "md",
  disabled = false,
  id,
  className = "",
  ...inputProps
}: RangeSliderProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const lower = Number.isFinite(min) ? min : 0;
  const upper = Math.max(lower, Number.isFinite(max) ? max : 100);
  const increment =
    step === "any" ? "any" : Number.isFinite(step) && step > 0 ? step : 1;
  const [internalValue, setInternalValue] = useState(
    defaultValue ?? lower + (upper - lower) / 2,
  );
  const requested = value ?? internalValue;
  const bounded = Math.max(
    lower,
    Math.min(upper, Number.isFinite(requested) ? requested : lower),
  );
  const selected =
    increment === "any"
      ? bounded
      : Number(
          Math.min(
            lower + Math.floor((upper - lower) / increment + 1e-10) * increment,
            lower + Math.round((bounded - lower) / increment) * increment,
          ).toPrecision(12),
        );
  const fill =
    upper === lower ? 0 : ((selected - lower) / (upper - lower)) * 100;
  const descriptionId = `${inputId}-description`;
  const describedBy =
    [inputProps["aria-describedby"], description ? descriptionId : ""]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div
      className={`range-slider ${className}`}
      data-size={size}
      data-disabled={disabled}
      style={{ "--range-fill": `${fill}%` } as CSSProperties}
    >
      <div className="range-slider-heading">
        <label htmlFor={inputId}>{label}</label>
        <output htmlFor={inputId}>{formatValue(selected)}</output>
      </div>
      <input
        {...inputProps}
        id={inputId}
        className="range-slider-input"
        type="range"
        min={lower}
        max={upper}
        step={increment}
        value={selected}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-valuetext={formatValue(selected)}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (value === undefined) setInternalValue(next);
          onChange?.(next);
        }}
      />
      <div className="range-slider-bounds" aria-hidden="true">
        <span>{formatValue(lower)}</span>
        <span>{formatValue(upper)}</span>
      </div>
      {description && (
        <p id={descriptionId} className="range-slider-description">
          {description}
        </p>
      )}
    </div>
  );
}
