import { useCallback, useEffect, useState } from "react";

import { brand } from "@/lib/brand";

type Theme = "light" | "dark";

function readStoredTheme(): Theme {
  if (typeof window === "undefined") {
    return "light";
  }

  const stored = localStorage.getItem(brand.themeStorageKey);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return stored === "dark" || (!stored && prefersDark) ? "dark" : "light";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // 用户未显式选择主题时，跟随系统明暗变化实时切换。
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => {
      if (localStorage.getItem(brand.themeStorageKey) === null) {
        setTheme(event.matches ? "dark" : "light");
      }
    };

    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  // 只在显式切换时持久化；未选择过则继续跟随系统偏好。
  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    localStorage.setItem(brand.themeStorageKey, next);
    setTheme(next);
  }, [theme]);

  return { theme, toggleTheme };
}
