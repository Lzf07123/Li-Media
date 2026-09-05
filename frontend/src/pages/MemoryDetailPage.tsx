import { useEffect, useState } from "react";
import { Image as ImageIcon, Images, Video } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import PhotoPreview from "@/components/PhotoPreview";
import VideoPlayer from "@/components/VideoPlayer";
import FileStatusBadge from "@/components/FileStatusBadge";
import RemoteStateBadge from "@/components/RemoteStateBadge";
import { brand } from "@/lib/brand";
import { formatBytes, formatDateTime, formatDuration } from "@/lib/format";
import { getMemoryById, resolveMediaUrl, type Memory } from "@/lib/api";
import Breadcrumb from "@/components/ui/Breadcrumb";
import EmptyState from "@/components/ui/EmptyState";
import MediaSkeleton from "@/components/ui/MediaSkeleton";

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) {
    return null;
  }

  return (
    <div className="grid gap-1 sm:grid-cols-[140px_1fr]">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

export default function MemoryDetailPage() {
  const { memoryId } = useParams();
  const [memory, setMemory] = useState<Memory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!memoryId) {
      return;
    }

    let active = true;

    getMemoryById(memoryId)
      .then((data) => {
        if (active) {
          setMemory(data);
        }
      })
      .catch(() => {
        if (active) {
          setError(brand.copy.notFoundTitle);
        }
      });

    return () => {
      active = false;
    };
  }, [memoryId]);

  if (error || (!memory && !error)) {
    return error ? (
      <div className="mt-8">
        <EmptyState art={Images}>
          {error}
          <Link className="empty-state-action text-primary" to="/">
            {brand.copy.backHome}
          </Link>
        </EmptyState>
      </div>
    ) : (
      <MediaSkeleton count={1} />
    );
  }

  if (!memory) {
    return null;
  }

  const capturedAt = formatDateTime(memory.captured_at);
  const dimensions =
    memory.width && memory.height ? `${memory.width} × ${memory.height}` : null;
  const duration = formatDuration(memory.duration_seconds);
  const fileSize = formatBytes(memory.primary_file?.size_bytes);
  const fileStatus = memory.primary_file?.status;
  const modifiedAt = formatDateTime(memory.primary_file?.modified_at);

  return (
    <article className="page-enter">
      <Breadcrumb
        items={[
          { children: brand.copy.breadcrumbHome, href: "/" },
          { children: brand.copy.breadcrumbLibrary, href: "/" },
          { children: brand.copy.breadcrumbDetail },
        ]}
      />

      <div className="card overflow-hidden p-0">
        <div className="bg-surface-2">
          {memory.kind === "video" ? (
            memory.primary_file?.stream_state === "ready" ? (
              <VideoPlayer
                dimensions={dimensions}
                duration={duration}
                poster={memory.thumbnail_url ? resolveMediaUrl(memory.thumbnail_url) : null}
                src={resolveMediaUrl(memory.file_url)}
              />
            ) : (
              <div
                aria-hidden="true"
                className="flex min-h-72 items-center justify-center text-muted"
              >
                <Video className="size-10" />
              </div>
            )
          ) : (
            memory.primary_file?.thumbnail_state === "ready" && memory.thumbnail_url ? (
              <PhotoPreview alt={memory.title} src={resolveMediaUrl(memory.thumbnail_url)} />
            ) : (
              <div
                aria-hidden="true"
                className="flex min-h-72 items-center justify-center text-muted"
              >
                <ImageIcon className="size-10" />
              </div>
            )
          )}
        </div>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section aria-labelledby="memory-title">
          <p className="text-sm text-muted">
            {memory.kind === "video" ? brand.copy.videoKind : brand.copy.photoKind}
          </p>
          <h1 className="mt-2 text-3xl font-semibold" id="memory-title">
            {memory.title}
          </h1>
          <h2 className="section-title mt-8">{brand.copy.detailDescription}</h2>
          <p className="whitespace-pre-line text-sm leading-6">
            {memory.description || brand.copy.noDescription}
          </p>
        </section>

        <aside className="card p-6">
          <h2 className="text-lg font-semibold">{brand.copy.detailCapture}</h2>
          <dl className="mt-4 space-y-3">
            <DetailRow label={brand.copy.detailCaptureTime} value={capturedAt} />
            <DetailRow label={brand.copy.detailLocation} value={memory.location} />
            <DetailRow label={brand.copy.detailDimensions} value={dimensions} />
            <DetailRow label={brand.copy.detailDuration} value={duration} />
          </dl>

          <h2 className="mt-8 text-lg font-semibold">{brand.copy.detailFile}</h2>
          <dl className="mt-4 space-y-3">
            <DetailRow label={brand.copy.detailFileSource} value={memory.primary_file?.source} />
            <DetailRow label={brand.copy.detailRemotePath} value={memory.primary_file?.remote_path} />
            <DetailRow label={brand.copy.detailFileFormat} value={memory.primary_file?.mime_type} />
            <DetailRow label={brand.copy.detailFileSize} value={fileSize} />
            <DetailRow label={brand.copy.detailRemoteModified} value={modifiedAt} />
            <dt className="text-sm text-muted">{brand.copy.detailFileStatus}</dt>
            <dd className="text-sm">{fileStatus ? <FileStatusBadge status={fileStatus} /> : null}</dd>
            <dt className="text-sm text-muted">{brand.copy.detailRemoteState}</dt>
            <dd className="text-sm">
              {memory.primary_file ? (
                <RemoteStateBadge kind="remote" state={memory.primary_file.remote_state} />
              ) : null}
            </dd>
            <dt className="text-sm text-muted">{brand.copy.detailPreviewState}</dt>
            <dd className="text-sm">
              {memory.primary_file ? (
                <RemoteStateBadge kind="thumbnail" state={memory.primary_file.thumbnail_state} />
              ) : null}
            </dd>
          </dl>
        </aside>
      </div>
    </article>
  );
}
