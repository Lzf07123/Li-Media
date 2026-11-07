import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

import { brand } from "@/lib/brand";

type Theme = "light" | "dark";

type ViewTransitionDocument = Document & {
  startViewTransition?: (updateCallback: () => void) => unknown;
};

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
    // View Transitions 可用且允许动效时整页交叉淡入（快照合成，不逐元素
    // 过渡，无闪烁）；否则保持瞬时切换。flushSync 保证新快照拿到切换后 DOM。
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const transitionDocument = document as ViewTransitionDocument;
    if (reduceMotion || typeof transitionDocument.startViewTransition !== "function") {
      setTheme(next);
      return;
    }
    transitionDocument.startViewTransition(() => {
      flushSync(() => setTheme(next));
    });
  }, [theme]);

  return { theme, toggleTheme };
}
