import { useEffect, useState } from "react";
import { Image as ImageIcon, Images, Video } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import PhotoPreview from "@/components/PhotoPreview";
import VideoPlayer from "@/components/VideoPlayer";
import FileStatusBadge from "@/components/FileStatusBadge";
import RemoteStateBadge from "@/components/RemoteStateBadge";
import { brand } from "@/lib/brand";
import {
  getMediaDirectLink,
  getMemoryById,
  resolveMediaUrl,
  type Memory,
} from "@/lib/api";
import Breadcrumb from "@/components/ui/Breadcrumb";
import EmptyState from "@/components/ui/EmptyState";
import MediaSkeleton from "@/components/ui/MediaSkeleton";

export default function MemoryDetailPage() {
  const { memoryId } = useParams();
  const [memory, setMemory] = useState<Memory | null>(null);
  const [directUrl, setDirectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!memoryId) {
      return;
    }

    let active = true;

    getMemoryById(memoryId)
      .then(async (data) => {
        if (active) {
          setMemory(data);
        }

        try {
          const link = await getMediaDirectLink(memoryId);
          if (active) {
            setDirectUrl(link.direct_url);
          }
        } catch {
          if (active) {
            setDirectUrl(null);
          }
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

  const fileStatus = memory.primary_file?.status;
  const remoteState = memory.primary_file?.remote_state;
  const thumbnailState = memory.primary_file?.thumbnail_state;
  const streamState = memory.primary_file?.stream_state;
  const fallbackMediaUrl =
    memory.kind === "video"
      ? memory.file_url
      : memory.thumbnail_url;
  const mediaSource = directUrl ?? fallbackMediaUrl;

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
            memory.primary_file?.stream_state === "ready" && mediaSource ? (
              <VideoPlayer
                dimensions={null}
                duration={null}
                poster={memory.thumbnail_url ? resolveMediaUrl(memory.thumbnail_url) : null}
                src={resolveMediaUrl(mediaSource)}
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
            mediaSource ? (
              <PhotoPreview
                alt={brand.copy.detailPreviewAlt}
                src={resolveMediaUrl(mediaSource)}
              />
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

      <div
        aria-label={brand.copy.detailStatusLabel}
        className="status-strip mt-4"
        role="list"
      >
        <div className="flex items-center gap-2" role="listitem">
          <span className="text-xs text-muted">{brand.copy.detailFileStatusLabel}</span>
          {fileStatus ? <FileStatusBadge status={fileStatus} /> : null}
        </div>
        <div className="flex items-center gap-2" role="listitem">
          <span className="text-xs text-muted">{brand.copy.detailRemoteState}</span>
          {remoteState ? <RemoteStateBadge kind="remote" state={remoteState} /> : null}
        </div>
        <div className="flex items-center gap-2" role="listitem">
          <span className="text-xs text-muted">{brand.copy.detailPreviewState}</span>
          {thumbnailState ? (
            <RemoteStateBadge kind="thumbnail" state={thumbnailState} />
          ) : null}
        </div>
        <div className="flex items-center gap-2" role="listitem">
          <span className="text-xs text-muted">{brand.copy.detailStreamState}</span>
          {streamState ? <RemoteStateBadge kind="stream" state={streamState} /> : null}
        </div>
      </div>
    </article>
  );
}
