const stored = localStorage.getItem("limedia-theme");
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.classList.toggle(
  "dark",
  stored === "dark" || (!stored && prefersDark),
);
