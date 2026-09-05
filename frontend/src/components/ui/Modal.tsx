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
  title: string;
  tone?: ModalTone;
};

export default function Modal({ children, onClose, open, title, tone = "info" }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousActive = document.activeElement;
    panelRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
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
        className={`modal-panel modal-panel-in ${toneClass[tone]} p-5 sm:p-6`}
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
