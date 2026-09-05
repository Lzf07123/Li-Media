import { ArrowUp } from "lucide-react";

import { brand } from "@/lib/brand";

export default function BackToTop() {
  return (
    <a aria-label={brand.copy.backTop} className="back-to-top" href="#main">
      <ArrowUp aria-hidden="true" />
    </a>
  );
}
