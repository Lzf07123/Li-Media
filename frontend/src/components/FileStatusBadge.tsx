import Badge from "@/components/ui/Badge";
import { brand } from "@/lib/brand";

type FileStatus = "discovered" | "matched" | "missing" | "removed";

const statusCopy: Record<FileStatus, string> = {
  discovered: brand.copy.fileDiscovered,
  matched: brand.copy.fileMatched,
  missing: brand.copy.fileMissing,
  removed: brand.copy.fileRemoved,
};

const statusTone: Record<FileStatus, "success" | "warning" | "danger" | "muted"> = {
  matched: "success",
  discovered: "warning",
  missing: "danger",
  removed: "muted",
};

export default function FileStatusBadge({ status }: { status: FileStatus }) {
  return <Badge tone={statusTone[status]}>{statusCopy[status]}</Badge>;
}
