import type { ComponentType, ReactNode } from "react";

type EmptyStateProps = {
  art?: ComponentType<{ className?: string }>;
  children: ReactNode;
};

export default function EmptyState({ art: Art, children }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {Art ? (
        <div aria-hidden="true" className="empty-state-art">
          <Art className="size-[42px]" />
        </div>
      ) : null}
      <p className="empty-state-text">{children}</p>
    </div>
  );
}
