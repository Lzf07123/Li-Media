import { brand } from "@/lib/brand";

// V1.5 暗夜档案馆：无存储偏好时默认深色（与 useTheme 同一规则）。
const stored = localStorage.getItem(brand.themeStorageKey);
document.documentElement.classList.toggle(
  "dark",
  stored !== "light",
);
