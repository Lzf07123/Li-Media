import Badge from "@/components/ui/Badge";
import { brand } from "@/lib/brand";
import type { Memory } from "@/lib/api";

const statusCopy: Record<Memory["status"], string> = {
  pending: brand.copy.statusPending,
  draft: brand.copy.statusDraft,
  published: brand.copy.statusPublished,
  hidden: brand.copy.statusHidden,
  error: brand.copy.statusError,
};

const statusTone: Record<Memory["status"], "success" | "warning" | "danger" | "muted"> = {
  published: "success",
  pending: "warning",
  draft: "muted",
  hidden: "muted",
  error: "danger",
};

export default function StatusBadge({ status }: { status: Memory["status"] }) {
  return <Badge tone={statusTone[status]}>{statusCopy[status]}</Badge>;
}
