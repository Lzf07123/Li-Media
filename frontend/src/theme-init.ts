import { brand } from "@/lib/brand";

const stored = localStorage.getItem(brand.themeStorageKey);
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.classList.toggle(
  "dark",
  stored === "dark" || (!stored && prefersDark),
);
