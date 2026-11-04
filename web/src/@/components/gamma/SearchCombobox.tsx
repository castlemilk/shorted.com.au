"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown, LoaderCircle, Search, X } from "lucide-react";

export type SearchComboboxOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  /** Additional words matched by the default local filter. */
  keywords?: readonly string[];
};

export type SearchComboboxProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange" | "children" | "size"
> & {
  options: readonly SearchComboboxOption[];
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (
    value: string | null,
    option: SearchComboboxOption | null,
  ) => void;
  query?: string;
  defaultQuery?: string;
  onQueryChange?: (query: string) => void;
  label?: string;
  /** Turn off local filtering when the consumer supplies server-filtered results. */
  filter?: boolean;
  clearable?: boolean;
  openOnFocus?: boolean;
  loading?: boolean;
  loadingMessage?: string;
  emptyMessage?: string;
  error?: string;
  onRetry?: () => void;
  onOpenChange?: (open: boolean) => void;
};

/** A searchable single choice. The input retains focus while options are active. */
export function SearchCombobox({
  options,
  value,
  defaultValue = null,
  onValueChange,
  query,
  defaultQuery = "",
  onQueryChange,
  label = "Choose an option",
  filter = true,
  clearable = true,
  openOnFocus = false,
  loading = false,
  loadingMessage = "Loading options…",
  emptyMessage = "No options match your search.",
  error,
  onRetry,
  onOpenChange,
  disabled = false,
  readOnly = false,
  placeholder = "Search options…",
  className,
  id,
  name,
  onFocus,
  onBlur,
  onKeyDown,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  ...props
}: SearchComboboxProps) {
  const instanceId = useId();
  const inputId = id ?? `${instanceId}-input`;
  const listId = `${instanceId}-list`;
  const statusId = `${instanceId}-status`;
  const rootRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef(new Map<string, HTMLLIElement>());
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [internalQuery, setInternalQuery] = useState(defaultQuery);
  const [isOpen, setIsOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const selected = value === undefined ? internalValue : value;
  const text = query ?? internalQuery;
  const selectedOption = options.find((option) => option.value === selected);
  // A remote result set may omit a previously chosen option. Keep its last
  // known label without silently changing the consumer's selected value.
  const [rememberedOption, setRememberedOption] = useState<Pick<
    SearchComboboxOption,
    "value" | "label"
  > | null>(selectedOption ?? null);
  if (
    selectedOption &&
    (rememberedOption?.value !== selectedOption.value ||
      rememberedOption.label !== selectedOption.label)
  ) {
    setRememberedOption({
      value: selectedOption.value,
      label: selectedOption.label,
    });
  } else if (selected === null && rememberedOption) {
    setRememberedOption(null);
  }
  if ((disabled || readOnly) && isOpen) setIsOpen(false);
  const selectedLabel =
    selectedOption?.label ??
    (rememberedOption?.value === selected
      ? rememberedOption.label
      : (selected ?? ""));
  const open = isOpen && !disabled && !readOnly;
  const normalizedQuery = text.trim().toLocaleLowerCase();
  const visible = options.filter(
    (option) =>
      !filter ||
      !normalizedQuery ||
      [option.label, ...(option.keywords ?? [])].some((word) =>
        word.toLocaleLowerCase().includes(normalizedQuery),
      ),
  );
  const available =
    !loading && !error ? visible.filter((option) => !option.disabled) : [];
  const active =
    available.find((option) => option.value === activeValue) ??
    available.find((option) => option.value === selected) ??
    available[0];
  const optionId = (optionValue: string) =>
    `${instanceId}-option-${encodeURIComponent(optionValue)}`;

  function setQuery(next: string) {
    if (query === undefined) setInternalQuery(next);
    onQueryChange?.(next);
    setActiveValue(null);
  }

  function setOpen(next: boolean) {
    if (disabled || readOnly || next === open) return;
    setIsOpen(next);
    onOpenChange?.(next);
  }

  function close() {
    setOpen(false);
  }

  function commit(option: SearchComboboxOption | null) {
    if (disabled || readOnly || option?.disabled) return;
    const next = option?.value ?? null;
    if (value === undefined) setInternalValue(next);
    setRememberedOption(option);
    onValueChange?.(next, option);
    setQuery("");
    close();
    inputRef.current?.focus({ preventScroll: true });
  }

  // Native popover promotes this descendant into the top layer without a
  // portal, retaining the nearest design-system scope's inherited tokens.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const field = fieldRef.current;
    if (!panel || !field) return;
    if (!open) {
      if (panel.matches(":popover-open")) panel.hidePopover();
      return;
    }
    if (!panel.matches(":popover-open")) panel.showPopover();
    function position() {
      if (!panel || !field) return;
      const rect = field.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportWidth =
        viewport?.width ?? document.documentElement.clientWidth;
      const margin = 8;
      const gap = 6;
      const width = Math.min(
        rect.width,
        Math.max(0, viewportWidth - margin * 2),
      );
      panel.style.width = `${width}px`;
      const below = viewportTop + viewportHeight - rect.bottom - gap - margin;
      const above = rect.top - viewportTop - gap - margin;
      const preferredHeight = Math.min(panel.scrollHeight, 280);
      const flipped = below < preferredHeight && above > below;
      const availableHeight = Math.max(0, flipped ? above : below);
      const height = Math.min(preferredHeight, availableHeight);
      panel.style.maxHeight = `${availableHeight}px`;
      panel.style.left = `${Math.max(viewportLeft + margin, Math.min(rect.left, viewportLeft + viewportWidth - width - margin))}px`;
      panel.style.top = `${flipped ? rect.top - gap - height : rect.bottom + gap}px`;
      panel.dataset.side = flipped ? "above" : "below";
    }
    position();
    const observer = new ResizeObserver(position);
    observer.observe(field);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    function outside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
        onOpenChange?.(false);
      }
    }
    document.addEventListener("pointerdown", outside, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open, text, options, loading, error, onOpenChange]);

  const activeKey = active?.value;
  useLayoutEffect(() => {
    if (open && activeKey)
      optionRefs.current.get(activeKey)?.scrollIntoView({ block: "nearest" });
  }, [open, activeKey]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing || readOnly)
      return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (!open) {
        setQuery("");
        setActiveValue(
          direction > 0
            ? (available[0]?.value ?? null)
            : (available.at(-1)?.value ?? null),
        );
        setOpen(true);
      } else if (available.length) {
        const index = available.findIndex(
          (option) => option.value === active?.value,
        );
        setActiveValue(
          available[(index + direction + available.length) % available.length]?.value ??
            null,
        );
      }
    } else if (
      open &&
      (event.key === "Home" || event.key === "End") &&
      event.altKey
    ) {
      event.preventDefault();
      setActiveValue(
        (event.key === "Home" ? available[0] : available.at(-1))?.value ?? null,
      );
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      if (error && onRetry && !loading) onRetry();
      else if (active) commit(active);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") close();
  }

  return (
    <div
      ref={rootRef}
      className={["search-combobox", className].filter(Boolean).join(" ")}
      data-disabled={disabled || undefined}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <div
        ref={fieldRef}
        className="search-combobox-field"
        data-open={open || undefined}
      >
        <Search
          size={16}
          aria-hidden="true"
          className="search-combobox-search"
        />
        <input
          {...props}
          ref={inputRef}
          id={inputId}
          role="combobox"
          aria-label={ariaLabel ?? (ariaLabelledBy ? undefined : label)}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={
            [
              ariaDescribedBy,
              // Booleans and a message: the falsy values are the point, so no `??`.
              // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
              open && (loading || error || !visible.length) ? statusId : "",
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={
            open && active ? optionId(active.value) : undefined
          }
          aria-autocomplete="list"
          // A false aria-invalid is no invalid mark, so the falsy values are read, not defaulted.
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          aria-invalid={Boolean(error) || props["aria-invalid"] || undefined}
          autoComplete="off"
          disabled={disabled}
          readOnly={readOnly}
          placeholder={placeholder}
          value={open ? text : selectedLabel}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setOpen(true);
          }}
          onFocus={(event) => {
            onFocus?.(event);
            if (openOnFocus) {
              setQuery("");
              setOpen(true);
            }
          }}
          onBlur={onBlur}
          onKeyDown={handleKeyDown}
        />
        {clearable && (selected !== null || (open && text)) && (
          <button
            type="button"
            className="search-combobox-action"
            aria-label={`Clear ${label.toLocaleLowerCase()}`}
            disabled={disabled || readOnly}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commit(null)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="search-combobox-action search-combobox-toggle"
          aria-label={`${open ? "Hide" : "Show"} options`}
          aria-expanded={open}
          aria-controls={listId}
          tabIndex={-1}
          disabled={disabled || readOnly}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            inputRef.current?.focus({ preventScroll: true });
            if (!open) setQuery("");
            setOpen(!open);
          }}
        >
          <ChevronDown size={15} aria-hidden="true" />
        </button>
      </div>
      {name && (
        <input
          type="hidden"
          name={name}
          value={selected ?? ""}
          disabled={disabled}
        />
      )}
      <div ref={panelRef} className="search-combobox-panel" popover="manual">
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label} options`}
          aria-busy={loading || undefined}
          className="search-combobox-list"
        >
          {!loading &&
            !error &&
            visible.map((option) => (
              // The options are a listbox driven from the input's keyboard, so the
              // click is a pointer shortcut and the key handling lives on the field.
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
              <li
                key={option.value}
                id={optionId(option.value)}
                ref={(element) => {
                  if (element) optionRefs.current.set(option.value, element);
                  else optionRefs.current.delete(option.value);
                }}
                role="option"
                aria-selected={selected === option.value}
                // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
                aria-disabled={option.disabled || undefined}
                data-active={active?.value === option.value || undefined}
                className="search-combobox-option"
                onMouseDown={(event) => event.preventDefault()}
                onPointerMove={() => {
                  if (!option.disabled) setActiveValue(option.value);
                }}
                onClick={() => commit(option)}
              >
                <span className="search-combobox-option-copy">
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </span>
                <span className="search-combobox-check" aria-hidden="true">
                  {selected === option.value && <Check size={16} />}
                </span>
              </li>
            ))}
        </ul>
        {/* eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing */}
        {(loading || error || !visible.length) && (
          <div
            id={statusId}
            className="search-combobox-status"
            role={error ? "alert" : "status"}
          >
            {loading ? (
              <>
                <LoaderCircle
                  size={16}
                  aria-hidden="true"
                  className="search-combobox-spinner"
                />
                <span>{loadingMessage}</span>
              </>
            ) : error ? (
              <>
                <span>{error}</span>
                {onRetry && (
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={onRetry}
                  >
                    Try again <small>(Enter)</small>
                  </button>
                )}
              </>
            ) : (
              <span>{emptyMessage}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
