import { useCallback, useEffect, useState } from "react";

import { brand } from "@/lib/brand";

type Theme = "light" | "dark";

// V1.5 暗夜档案馆：无存储偏好时默认深色（与 theme-init.ts 同一规则）。
function readStoredTheme(): Theme {
  if (typeof window === "undefined") {
    return "dark";
  }

  return localStorage.getItem(brand.themeStorageKey) === "light"
    ? "light"
    : "dark";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // 用户未显式选择主题时保持默认深色；显式选择后不再自动切换。
  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    localStorage.setItem(brand.themeStorageKey, next);
    setTheme(next);
  }, [theme]);

  return { theme, toggleTheme };
}
