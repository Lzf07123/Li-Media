import Badge from "@/components/ui/Badge";
import { brand } from "@/lib/brand";

export type ObservabilityKind = "remote" | "thumbnail" | "stream";

type RemoteState = "unverified" | "ready" | "missing" | "failed";
type ThumbnailState = "missing" | "ready" | "failed" | "retryable";
type StreamState = "unavailable" | "ready" | "failed";

type ObservabilityState = RemoteState | ThumbnailState | StreamState;

const copy: Record<ObservabilityKind, Record<string, string>> = {
  remote: {
    unverified: brand.copy.adminRemoteUnverified,
    ready: brand.copy.adminRemoteReady,
    missing: brand.copy.adminRemoteMissing,
    failed: brand.copy.adminRemoteFailed,
  },
  thumbnail: {
    missing: brand.copy.adminThumbnailMissing,
    ready: brand.copy.adminThumbnailReady,
    retryable: brand.copy.adminThumbnailRetryable,
    failed: brand.copy.adminThumbnailFailed,
  },
  stream: {
    unavailable: brand.copy.adminStreamUnavailable,
    ready: brand.copy.adminStreamReady,
    failed: brand.copy.adminStreamFailed,
  },
};

const tones: Record<string, "primary" | "success" | "warning" | "danger" | "muted"> = {
  ready: "success",
  unverified: "warning",
  missing: "muted",
  unavailable: "muted",
  retryable: "warning",
  failed: "danger",
};

export default function RemoteStateBadge({
  kind,
  state,
}: {
  kind: ObservabilityKind;
  state: ObservabilityState;
}) {
  return <Badge tone={tones[state]}>{copy[kind][state]}</Badge>;
}
