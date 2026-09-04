import { Film } from "lucide-react";
import { Link } from "react-router-dom";

import { brand } from "@/lib/brand";

export default function SiteHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-surface/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Link
          to="/"
          className="flex min-h-11 items-center gap-2 rounded-md text-lg font-semibold"
        >
          <Film aria-hidden="true" className="size-5 text-primary" />
          {brand.name}
        </Link>

        <nav aria-label="主导航" className="ml-auto hidden gap-1 sm:flex">
          {brand.nav.map((item) => (
            <Link
              key={item.href}
              to={item.href}
              className="flex min-h-11 items-center rounded-md px-3 text-sm text-muted transition hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

