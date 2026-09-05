import { ChevronLeft, ChevronRight } from "lucide-react";

import { brand } from "@/lib/brand";
import IconButton from "@/components/ui/IconButton";

type PaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
};

export default function Pagination({ page, pageSize, total, onPageChange }: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <nav aria-label={brand.copy.paginationLabel} className="pagination">
      <IconButton
        aria-disabled={page <= 1}
        aria-label={brand.copy.previousPage}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        <ChevronLeft aria-hidden="true" />
      </IconButton>
      <span className="pagination-info">
        {page} / {pageCount}
      </span>
      <IconButton
        aria-disabled={page >= pageCount}
        aria-label={brand.copy.nextPage}
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        <ChevronRight aria-hidden="true" />
      </IconButton>
    </nav>
  );
}
