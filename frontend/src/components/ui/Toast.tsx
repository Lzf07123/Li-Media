import { X } from "lucide-react";

import { brand } from "@/lib/brand";
import IconButton from "@/components/ui/IconButton";

export type Toast = {
  id: number;
  message: string;
  tone: "success" | "error" | "info" | "warning";
};

const toneClass = {
  success: "toast-success",
  error: "toast-error",
  info: "toast-info",
  warning: "toast-warning",
};

export function ToastViewport({
  onDismiss,
  toasts,
}: {
  onDismiss: (id: number) => void;
  toasts: Toast[];
}) {
  return (
    <div aria-live="polite" className="toast-viewport">
      {toasts.map((toast) => (
        <div className={`toast toast-enter ${toneClass[toast.tone]}`} key={toast.id}>
          <div className="min-w-0">
            <p className="toast-title">{toast.message}</p>
          </div>
          <IconButton
            aria-label={brand.copy.adminCancel}
            className="toast-close ml-auto"
            onClick={() => onDismiss(toast.id)}
          >
            <X aria-hidden="true" />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
