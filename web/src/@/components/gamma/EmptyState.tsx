import type { HTMLAttributes, ReactNode } from "react";

export type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: string;
  description?: string;
  icon?: ReactNode;
};

/** A contextual empty state whose consumer supplies the recovery actions. */
export function EmptyState({
  title,
  description,
  icon,
  children,
  className = "",
  ...divProps
}: EmptyStateProps) {
  return (
    <div {...divProps} className={`empty-state ${className}`}>
      {icon && (
        <span className="empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {children && <div className="empty-state-actions">{children}</div>}
    </div>
  );
}
