import { useEffect, useState } from "react";
import { Image as ImageIcon, ZoomIn } from "lucide-react";

import Button from "@/components/ui/Button";
import PhotoViewer from "@/components/PhotoViewer";
import { brand } from "@/lib/brand";

type PhotoPreviewProps = {
  alt: string;
  fullSrc: string;
  onSourceError?: () => void;
  serverSrc?: string;
  thumbnailSrc?: string | null;
};

type LoadState = "loading" | "ready" | "error";

export default function PhotoPreview({
  alt,
  fullSrc,
  onSourceError,
  serverSrc,
  thumbnailSrc,
}: PhotoPreviewProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [viewerOpen, setViewerOpen] = useState(false);
  const [inlineSrc, setInlineSrc] = useState(() => thumbnailSrc ?? fullSrc);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    setInlineSrc(thumbnailSrc ?? fullSrc);
    setLoadState("loading");
  }, [fullSrc, retryKey, thumbnailSrc]);

  const handleInlineError = () => {
    if (inlineSrc !== fullSrc) {
      setInlineSrc(fullSrc);
      setLoadState("loading");
      return;
    }

    setLoadState("error");
    onSourceError?.();
  };

  return (
    <div className="relative flex min-h-72 size-full items-center justify-center">
      {loadState === "loading" ? (
        <div aria-live="polite" className="absolute inset-0 flex items-center justify-center">
          <span className="spinner text-primary" />
          <span className="sr-only">{brand.copy.detailMediaLoading}</span>
        </div>
      ) : null}

      {loadState === "error" ? (
        <div className="flex flex-col items-center gap-4 p-6 text-center text-muted">
          <ImageIcon aria-hidden="true" className="size-10" />
          <p className="text-sm">{brand.copy.detailImageLoadFailed}</p>
          <Button
            onClick={() => {
              setLoadState("loading");
              setRetryKey((current) => current + 1);
            }}
            variant="secondary"
          >
            {brand.copy.detailRetry}
          </Button>
        </div>
      ) : (
        <button
          aria-label={brand.copy.detailOpenViewer}
          className="relative block size-full cursor-zoom-in"
          onClick={() => setViewerOpen(true)}
          type="button"
        >
          <img
            alt={alt}
            className={`size-full object-contain transition-opacity duration-200 ${
              loadState === "loading" ? "opacity-0" : "opacity-100"
            }`}
            decoding="async"
            onError={handleInlineError}
            onLoad={() => setLoadState("ready")}
            src={inlineSrc}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-3 rounded-md border border-border bg-surface/85 p-1.5 text-foreground backdrop-blur-sm"
          >
            <ZoomIn className="size-4" />
          </span>
        </button>
      )}

      {viewerOpen ? (
        <PhotoViewer
          alt={alt}
          onClose={() => setViewerOpen(false)}
          onError={onSourceError}
          src={fullSrc}
          fallbackSrc={serverSrc}
        />
      ) : null}
    </div>
  );
}
