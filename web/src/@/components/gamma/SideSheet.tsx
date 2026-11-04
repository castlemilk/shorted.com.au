"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { X } from "lucide-react";

export type SideSheetProps = Omit<
  ComponentPropsWithoutRef<"dialog">,
  "open" | "title" | "children" | "onClose" | "onCancel"
> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Content of the built-in trigger. Null hides it for an external trigger. */
  trigger?: ReactNode;
  /** "bottom" is the workspace's local change (gamma README, "Local changes"): a sheet from the bottom edge below `lg`. */
  side?: "left" | "right" | "bottom";
  dismissible?: boolean;
  closeLabel?: string;
};

const scrollLocks = new WeakMap<
  HTMLElement,
  { count: number; overflow: string }
>();

function lockScroll(body: HTMLElement) {
  const existing = scrollLocks.get(body);
  const lock = existing ?? { count: 0, overflow: body.style.overflow };
  if (!existing) scrollLocks.set(body, lock);
  lock.count += 1;
  body.style.overflow = "hidden";
  return () => {
    lock.count -= 1;
    if (lock.count === 0) {
      body.style.overflow = lock.overflow;
      scrollLocks.delete(body);
    }
  };
}

/** A native modal sheet that stays inside its surrounding design-system scope. */
export function SideSheet({
  open,
  defaultOpen = false,
  onOpenChange,
  title,
  description,
  children,
  footer,
  trigger = "Open sheet",
  side = "right",
  dismissible = true,
  closeLabel = "Close sheet",
  className = "",
  id,
  onClick,
  ...dialogProps
}: SideSheetProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = open ?? internalOpen;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const ignoredCloseRef = useRef(0);
  const generatedId = useId();
  const dialogId = id ?? `side-sheet-${generatedId}`;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  function requestOpen(next: boolean) {
    if (open === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !isOpen) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!dialog.open) dialog.showModal();
    titleRef.current?.focus();
    const unlock = lockScroll(document.body);
    return () => {
      const shouldRestore =
        document.activeElement === document.body ||
        dialog.contains(document.activeElement);
      if (dialog.open) {
        ignoredCloseRef.current += 1;
        dialog.close();
      }
      unlock();
      if (shouldRestore && openerRef.current?.isConnected)
        openerRef.current.focus();
    };
  }, [isOpen]);

  return (
    <>
      {trigger !== null && (
        <button
          className="side-sheet-trigger"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls={dialogId}
          onClick={() => requestOpen(true)}
        >
          {trigger}
        </button>
      )}
      {/* A click on the dialog itself is a backdrop click (Escape closes it natively). */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
      <dialog
        {...dialogProps}
        ref={dialogRef}
        id={dialogId}
        className={`side-sheet ${className}`}
        data-side={side}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        onCancel={(event) => {
          event.preventDefault();
          if (dismissible) requestOpen(false);
        }}
        onClose={() => {
          // A method="dialog" form can close the native dialog too.
          if (ignoredCloseRef.current > 0) {
            ignoredCloseRef.current -= 1;
            return;
          }
          requestOpen(false);
        }}
        onClick={(event) => {
          onClick?.(event);
          if (
            !dismissible ||
            event.defaultPrevented ||
            event.target !== event.currentTarget
          )
            return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            requestOpen(false);
        }}
      >
        <header className="side-sheet-header">
          <div>
            <h2 ref={titleRef} id={titleId} tabIndex={-1}>
              {title}
            </h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <button
            className="side-sheet-close"
            type="button"
            aria-label={closeLabel}
            onClick={() => requestOpen(false)}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="side-sheet-body">{children}</div>
        {footer && <footer className="side-sheet-footer">{footer}</footer>}
      </dialog>
    </>
  );
}
