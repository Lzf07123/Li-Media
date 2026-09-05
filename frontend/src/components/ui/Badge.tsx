import type { ReactNode } from "react";

type BadgeTone = "primary" | "success" | "warning" | "danger" | "muted";

const toneClass: Record<BadgeTone, string> = {
  primary: "badge-primary",
  success: "badge-success",
  warning: "badge-warning",
  danger: "badge-danger",
  muted: "badge-muted",
};

export default function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: BadgeTone;
}) {
  return <span className={`badge ${toneClass[tone]}`}>{children}</span>;
}
