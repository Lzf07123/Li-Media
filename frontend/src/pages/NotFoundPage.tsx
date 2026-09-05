import { Link } from "react-router-dom";
import { FileQuestion } from "lucide-react";

import { brand } from "@/lib/brand";
import EmptyState from "@/components/ui/EmptyState";

export default function NotFoundPage() {
  return (
    <div className="mt-8">
      <EmptyState art={FileQuestion}>
        <span className="mb-2 block text-xl font-semibold text-foreground">
          {brand.copy.notFoundTitle}
        </span>
        {brand.copy.notFoundText}
        <Link className="empty-state-action text-primary" to="/">
          {brand.copy.backHome}
        </Link>
      </EmptyState>
    </div>
  );
}
