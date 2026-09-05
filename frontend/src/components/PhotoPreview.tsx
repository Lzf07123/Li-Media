import { useEffect, useState } from "react";
import { Image as ImageIcon, ZoomIn } from "lucide-react";

import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { brand } from "@/lib/brand";

type PhotoPreviewProps = {
  alt: string;
  src: string;
};

type LoadState = "loading" | "ready" | "error";

export default function PhotoPreview({ alt, src }: PhotoPreviewProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [viewerOpen, setViewerOpen] = useState(false);

  useEffect(() => {
    setLoadState("loading");
    setViewerOpen(false);
  }, [src]);

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
          <Button onClick={() => setLoadState("loading")} variant="secondary">
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
            onError={() => setLoadState("error")}
            onLoad={() => setLoadState("ready")}
            src={src}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-3 rounded-md border border-border bg-surface/85 p-1.5 text-foreground backdrop-blur-sm"
          >
            <ZoomIn className="size-4" />
          </span>
        </button>
      )}

      <Modal
        onClose={() => setViewerOpen(false)}
        open={viewerOpen}
        panelClassName="max-w-5xl"
        title={alt}
      >
        <div className="mt-4 overflow-hidden rounded-xl bg-surface-2">
          <img alt={alt} className="max-h-[72vh] w-full object-contain" src={src} />
        </div>
      </Modal>
    </div>
  );
}
