import { useEffect, useRef, useState } from "react";
import { Clock, Ratio } from "lucide-react";

import { brand } from "@/lib/brand";

type VideoPlayerProps = {
  onSourceError?: (error?: MediaError) => void;
  onReady?: () => void;
  onBufferingChange?: (isBuffering: boolean) => void;
  src: string;
  poster?: string | null;
  duration?: string | null;
  dimensions?: string | null;
};

export default function VideoPlayer({
  onSourceError,
  onReady,
  onBufferingChange,
  src,
  poster,
  duration,
  dimensions,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);

  useEffect(() => {
    setIsReady(false);
    setIsBuffering(false);
    setIsSeeking(false);
  }, [src]);

  useEffect(() => () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    video.pause();
    video.removeAttribute("src");
    video.load();
  }, []);

  return (
    <div className="relative size-full">
      {isBuffering || isSeeking ? (
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
        onError={() => {
          onSourceError?.(videoRef.current?.error ?? undefined);
        }}
        onCanPlay={() => {
          setIsReady(true);
          onReady?.();
          onBufferingChange?.(false);
          setIsBuffering(false);
          setIsSeeking(false);
        }}
        onLoadedData={() => setIsReady(true)}
        onPlaying={() => {
          onBufferingChange?.(false);
          setIsBuffering(false);
          setIsSeeking(false);
        }}
        onSeeked={() => setIsSeeking(false)}
        onSeeking={() => {
          setIsSeeking(true);
          onBufferingChange?.(true);
        }}
        onWaiting={() => {
          setIsBuffering(true);
          onBufferingChange?.(true);
        }}
        poster={poster ?? undefined}
        preload="metadata"
        ref={videoRef}
        src={src}
      />
    </div>
  );
}
