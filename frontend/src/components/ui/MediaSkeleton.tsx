export default function MediaSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div aria-label="loading" aria-live="polite" className="masonry">
      {Array.from({ length: count }).map((_, index) => (
        <div className="post-card overflow-hidden" key={index}>
          <div className="shimmer h-44 rounded-xl" />
          <div className="mt-4 space-y-2">
            <div className="shimmer h-4 w-3/4 rounded-full" />
            <div className="shimmer h-3 w-1/2 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
