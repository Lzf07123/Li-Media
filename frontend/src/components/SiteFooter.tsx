import { brand } from "@/lib/brand";
import { Link } from "react-router-dom";

export default function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4 text-xs text-muted sm:px-6 lg:px-8">
        <span>{brand.name}</span>
        <span className="flex items-center gap-3">
          {brand.description}
          <Link className="text-muted hover:text-foreground" to="/admin">
            管理
          </Link>
        </span>
      </div>
    </footer>
  );
}
