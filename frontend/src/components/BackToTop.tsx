import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";

import { brand } from "@/lib/brand";

// 滚过约一屏才浮现，回到顶部附近即退场；显隐只动 opacity/transform，
// 隐藏态 visibility 同步撤出 Tab 焦点序。reduced-motion 由全局规则收敛为瞬时。
const SHOW_AFTER_VIEWPORT_RATIO = 0.6;

export default function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      setVisible(window.scrollY > window.innerHeight * SHOW_AFTER_VIEWPORT_RATIO);
    };
    const onScroll = () => {
      if (!raf) {
        raf = requestAnimationFrame(update);
      }
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) {
        cancelAnimationFrame(raf);
      }
    };
  }, []);

  return (
    <a
      aria-label={brand.copy.backTop}
      className={`back-to-top ${visible ? "is-visible" : ""}`}
      href="#main"
      onClick={(event) => {
        // href="#main" 只作无 JS 兜底：锚点会落在页眉高度并污染 URL hash，
        // 这里拦截后精确回 0，平滑滚动尊重 reduced-motion。
        event.preventDefault();
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
      }}
    >
      <ArrowUp aria-hidden="true" />
    </a>
  );
}
