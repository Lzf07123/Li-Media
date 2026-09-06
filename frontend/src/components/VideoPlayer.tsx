import { useEffect, useState } from "react";
import { Clock, Ratio, Video } from "lucide-react";

import Button from "@/components/ui/Button";
import { brand } from "@/lib/brand";

type VideoPlayerProps = {
  onSourceError?: () => void;
  src: string;
  poster?: string | null;
  duration?: string | null;
  dimensions?: string | null;
};

export default function VideoPlayer({
  onSourceError,
  src,
  poster,
  duration,
  dimensions,
}: VideoPlayerProps) {
  const [isReady, setIsReady] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    setIsReady(false);
    setIsBuffering(false);
    setIsSeeking(false);
    setHasError(false);
  }, [src]);

  if (hasError) {
    return (
      <div className="flex min-h-72 flex-col items-center justify-center gap-4 p-6 text-center text-muted">
        <Video aria-hidden="true" className="size-10" />
        <p className="text-sm">{brand.copy.detailPlaybackFailed}</p>
        <Button
          onClick={() => {
            setHasError(false);
            setIsReady(false);
            setRetryKey((current) => current + 1);
          }}
          variant="secondary"
        >
          {brand.copy.detailRetry}
        </Button>
      </div>
    );
  }

  return (
    <div className="relative size-full">
      {!isReady || isBuffering || isSeeking ? (
        <div aria-live="polite" className="absolute inset-0 flex items-center justify-center">
          <span className="spinner text-primary" />
          <span className="video-state-label">
            {isSeeking
              ? brand.copy.detailSeeking
              : isBuffering
                ? brand.copy.detailBuffering
                : brand.copy.detailMediaLoading}
          </span>
        </div>
      ) : null}

      {isReady && (duration || dimensions) ? (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-wrap gap-2">
          {duration ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-surface/85 px-2 py-1 text-xs text-foreground backdrop-blur-sm">
              <Clock aria-hidden="true" className="size-3.5" />
              {duration}
            </span>
          ) : null}
          {dimensions ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-surface/85 px-2 py-1 text-xs text-foreground backdrop-blur-sm">
              <Ratio aria-hidden="true" className="size-3.5" />
              {dimensions}
            </span>
          ) : null}
        </div>
      ) : null}

      <video
        className={`size-full bg-surface-2 transition-opacity duration-200 ${
          isReady ? "opacity-100" : "opacity-0"
        }`}
        controls
        key={retryKey}
        onError={() => {
          setHasError(true);
          onSourceError?.();
        }}
        onCanPlay={() => {
          setIsReady(true);
          setIsBuffering(false);
          setIsSeeking(false);
        }}
        onLoadedData={() => setIsReady(true)}
        onPlaying={() => {
          setIsBuffering(false);
          setIsSeeking(false);
        }}
        onSeeked={() => setIsSeeking(false)}
        onSeeking={() => setIsSeeking(true)}
        onWaiting={() => setIsBuffering(true)}
        poster={poster ?? undefined}
        preload="metadata"
        src={src}
      />
    </div>
  );
}
