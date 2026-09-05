import type { ReactNode } from "react";

import { brand } from "@/lib/brand";

type BreadcrumbItem = {
  children: ReactNode;
  href?: string;
};

export default function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label={brand.copy.breadcrumbLabel} className="breadcrumb">
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span className="inline-flex items-center gap-2" key={index}>
            {isLast ? (
              <span aria-current="page">{item.children}</span>
            ) : item.href ? (
              <a href={item.href}>{item.children}</a>
            ) : (
              item.children
            )}
            {!isLast ? (
              <span aria-hidden="true" className="breadcrumb-sep">
                /
              </span>
            ) : null}
          </span>
        );
      })}
    </nav>
  );
}
