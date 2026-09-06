import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

import { brand } from "@/lib/brand";
import IconButton from "@/components/ui/IconButton";

type ModalTone = "danger" | "warning" | "success" | "info";

const toneClass: Record<ModalTone, string> = {
  danger: "modal-danger",
  warning: "modal-warning",
  success: "modal-success",
  info: "modal-info",
};

type ModalProps = {
  children: ReactNode;
  onClose: () => void;
  open: boolean;
  panelClassName?: string;
  title: string;
  tone?: ModalTone;
};

export default function Modal({
  children,
  onClose,
  open,
  panelClassName = "",
  title,
  tone = "info",
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousActive = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    panelRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      if (event.key === "Tab") {
        const focusable = Array.from(
          panelRef.current?.querySelectorAll<HTMLElement>(
            "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
          ) ?? [],
        ).filter((element) => !element.hasAttribute("disabled"));

        if (focusable.length === 0) {
          return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousActive instanceof HTMLElement) {
        previousActive.focus();
      }
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop modal-backdrop-in" onClick={onClose}>
      <div
        aria-modal="true"
        className={`modal-panel modal-panel-in ${toneClass[tone]} p-5 sm:p-6 ${panelClassName}`}
        onClick={(event) => event.stopPropagation()}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-start gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <IconButton aria-label={brand.copy.adminCancel} className="ml-auto" onClick={onClose}>
            <X aria-hidden="true" />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}
