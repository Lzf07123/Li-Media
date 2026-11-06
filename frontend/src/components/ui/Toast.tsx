import type { CSSProperties } from "react";
import { X } from "lucide-react";

import { brand } from "@/lib/brand";
import IconButton from "@/components/ui/IconButton";

// 自动消失时长：进度条动画与入队后的定时器共用同一来源，保持一致。
export const TOAST_DURATION_MS = 3600;

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
      {toasts.map((toast, index) => (
        <div
          className={`toast toast-enter ${toneClass[toast.tone]}`}
          key={toast.id}
          style={{ "--toast-index": index } as CSSProperties}
        >
          <div className="min-w-0">
            <p className="toast-title">{toast.message}</p>
          </div>
          <span
            aria-hidden="true"
            className="toast-progress"
            style={{ animationDuration: `${TOAST_DURATION_MS}ms` }}
          />
          <IconButton
            aria-label={brand.copy.close}
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
