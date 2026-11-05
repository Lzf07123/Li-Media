import { useEffect, useRef } from "react";
import { Camera, Menu, Moon, Sun, X } from "lucide-react";
import { Link, NavLink, useLocation, useSearchParams } from "react-router-dom";

import { brand } from "@/lib/brand";
import { useTheme } from "@/lib/useTheme";
import IconButton from "@/components/ui/IconButton";

export default function SiteHeader() {
  const { theme, toggleTheme } = useTheme();
  const menuRef = useRef<HTMLDetailsElement>(null);
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();

  // NavLink 只按 pathname 匹配，照片/视频与首页共用 "/" 会同时命中；
  // 回忆库导航的激活态改由 kind 查询参数判定，aria-current 在此显式声明。
  const kind = searchParams.get("kind");
  const activeLibraryHref = pathname === "/"
    ? kind === "photo" || kind === "video"
      ? `/?kind=${kind}`
      : "/"
    : null;
  const isNavActive = (href: string) => href === activeLibraryHref;

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }

    const closeMenu = (event: MouseEvent) => {
      if (!menu.contains(event.target as Node)) {
        menu.removeAttribute("open");
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.open) {
        menu.removeAttribute("open");
        menu.querySelector("summary")?.focus();
      }
    };

    document.addEventListener("click", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <header className="site-header sticky top-0 z-20 border-b border-border bg-surface/80 backdrop-blur">
      <div className="mx-auto flex h-12 w-full max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link className="brand flex min-h-11 items-center gap-2 rounded-md text-lg font-semibold" to="/">
          <Camera aria-hidden="true" className="brand-halo size-5 text-primary" />
          <span className="brand-name-text">{brand.name}</span>
        </Link>

        <nav aria-label={brand.copy.navLabel} className="site-nav ml-auto hidden items-center gap-1 sm:flex">
          {brand.nav.map((item) => {
            const active = isNavActive(item.href);
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center rounded-md px-3 text-sm transition ${
                  active ? "font-semibold text-foreground" : "text-muted hover:text-foreground"
                }`}
                key={item.href}
                to={item.href}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-1 sm:ml-0">
          <nav aria-label={brand.copy.navLabel} className="mobile-nav-primary">
            <Link className="mobile-nav-link" to="/">
              {brand.nav[0].label}
            </Link>
            <details className="site-menu" ref={menuRef}>
              <summary aria-label={brand.copy.moreMenu} className="site-menu-trigger">
                <span className="site-menu-icon site-menu-icon-open">
                  <Menu aria-hidden="true" />
                </span>
                <span className="site-menu-icon site-menu-icon-close">
                  <X aria-hidden="true" />
                </span>
                <span className="visually-hidden">{brand.copy.moreMenu}</span>
              </summary>
              <nav aria-label={brand.copy.moreMenu} className="site-menu-panel">
                {brand.nav.slice(1).map((item) => (
                  <Link
                    aria-current={isNavActive(item.href) ? "page" : undefined}
                    className="site-menu-item"
                    key={item.href}
                    onClick={() => menuRef.current?.removeAttribute("open")}
                    to={item.href}
                  >
                    {item.label}
                  </Link>
                ))}
                <span aria-hidden="true" className="site-menu-sep" />
                <NavLink
                  className="site-menu-item"
                  onClick={() => menuRef.current?.removeAttribute("open")}
                  to="/admin"
                >
                  {brand.copy.adminEntry}
                </NavLink>
              </nav>
            </details>
          </nav>

          <IconButton
            aria-label={theme === "dark" ? brand.copy.themeLight : brand.copy.themeDark}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          </IconButton>
        </div>
      </div>
    </header>
  );
}
