import type { ComponentType, ReactNode } from "react";

type EmptyStateProps = {
  action?: ReactNode;
  art?: ComponentType<{ className?: string }>;
  children: ReactNode;
};

export default function EmptyState({
  action,
  art: Art,
  children,
}: EmptyStateProps) {
  return (
    <div className="empty-state">
      {Art ? (
        <div aria-hidden="true" className="empty-state-art">
          <Art className="size-[42px]" />
        </div>
      ) : null}
      <p className="empty-state-text">{children}</p>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}
