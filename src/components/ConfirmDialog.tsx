import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";

interface ConfirmDialogProps {
  children: ReactNode;
  labelledBy: string;
  busy: boolean;
  onDismiss: () => void;
}

const focusableSelector = [
  "button:not(:disabled)",
  "a[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Accessible wrapper using the existing modal CSS; mount only while review is open. */
export function ConfirmDialog({
  children,
  labelledBy,
  busy,
  onDismiss,
}: ConfirmDialogProps) {
  const dialog = useRef<HTMLElement>(null);
  const callbacks = useRef({ busy, onDismiss });

  useLayoutEffect(() => {
    callbacks.current = { busy, onDismiss };
    // Disabled wallet-confirmation controls leave the dialog itself as the focus target.
    if (busy && dialog.current?.contains(document.activeElement))
      dialog.current.focus();
  }, [busy, onDismiss]);

  useLayoutEffect(() => {
    const section = dialog.current;
    if (!section) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    const inertElements: { element: HTMLElement; previous: boolean }[] = [];
    // Hide every branch outside the dialog from pointer and assistive-technology interaction.
    let branch: HTMLElement = section.parentElement!;
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling instanceof HTMLElement && sibling !== branch) {
          inertElements.push({ element: sibling, previous: sibling.inert });
          sibling.inert = true;
        }
      }
      if (branch.parentElement === document.body) break;
      branch = branch.parentElement;
    }
    document.body.style.overflow = "hidden";
    const targets = () =>
      [...section.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        (element) =>
          element.tabIndex >= 0 && element.getClientRects().length > 0,
      );
    const focusFirst = () => (targets()[0] || section).focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!callbacks.current.busy) callbacks.current.onDismiss();
      }
      if (event.key !== "Tab") return;
      const elements = targets();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) {
        event.preventDefault();
        section.focus();
        return;
      }
      const active = document.activeElement;
      if (
        event.shiftKey &&
        (active === first || active === section || !section.contains(active))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !section.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    const handleFocus = (event: FocusEvent) => {
      if (!section.contains(event.target as Node)) focusFirst();
    };
    document.addEventListener("keydown", handleKey, true);
    document.addEventListener("focusin", handleFocus);
    focusFirst();
    return () => {
      document.removeEventListener("keydown", handleKey, true);
      document.removeEventListener("focusin", handleFocus);
      for (const { element, previous } of inertElements)
        element.inert = previous;
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop">
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-busy={busy}
        className="review-modal"
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );
}
