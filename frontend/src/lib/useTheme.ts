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
    localStorage.setItem(brand.themeStorageKey, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  return { theme, toggleTheme };
}
