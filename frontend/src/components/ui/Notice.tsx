import type { ReactNode } from "react";

type NoticeTone = "success" | "warning" | "error" | "info";

const toneClass: Record<NoticeTone, string> = {
  success: "notice-success",
  warning: "notice-warning",
  error: "notice-error",
  info: "notice-info",
};

export default function Notice({
  className = "",
  children,
  tone = "info",
}: {
  className?: string;
  children: ReactNode;
  tone?: NoticeTone;
}) {
  return (
    <div aria-live="polite" className={`notice ${toneClass[tone]} ${className}`} role="status">
      {children}
    </div>
  );
}
