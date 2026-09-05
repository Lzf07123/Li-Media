import Badge from "@/components/ui/Badge";
import { brand } from "@/lib/brand";

type FileStatus =
  | "discovered"
  | "pending"
  | "syncing"
  | "matched"
  | "missing"
  | "removed"
  | "failed";

const statusCopy: Record<FileStatus, string> = {
  discovered: brand.copy.fileDiscovered,
  pending: brand.copy.filePending,
  syncing: brand.copy.fileSyncing,
  matched: brand.copy.fileMatched,
  missing: brand.copy.fileMissing,
  removed: brand.copy.fileRemoved,
  failed: brand.copy.fileFailed,
};

const statusTone: Record<
  FileStatus,
  "primary" | "success" | "warning" | "danger" | "muted"
> = {
  matched: "success",
  discovered: "warning",
  pending: "warning",
  syncing: "primary",
  missing: "danger",
  removed: "muted",
  failed: "danger",
};

export default function FileStatusBadge({ status }: { status: FileStatus }) {
  return <Badge tone={statusTone[status]}>{statusCopy[status]}</Badge>;
}
