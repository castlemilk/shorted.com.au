import type { ComponentPropsWithoutRef } from "react";

/** Keep wide Markdown tables inside the article column and keyboard-scrollable. */
export function ArticleTable({ className, ...props }: ComponentPropsWithoutRef<"table">) {
  return (
    <div
      role="region"
      aria-label="Article table"
      // A scroll region needs focus so keyboard users can move its content.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="w-full min-w-0 max-w-full overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <table className={`my-4 w-full break-normal ${className ?? ""}`} {...props} />
    </div>
  );
}
