export default function SearchSkeleton({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`search-skeleton ${className}`}>
      {[0, 1].map((index) => (
        <div className="search-skeleton-item" key={index}>
          <span className="search-skeleton-bar" />
          <span className="search-skeleton-bar" />
          <span className="search-skeleton-bar" />
        </div>
      ))}
    </div>
  );
}
