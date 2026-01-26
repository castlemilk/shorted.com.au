import * as React from "react";
import { type Column } from "@tanstack/react-table";
import { cn } from "~/@/lib/utils";

interface DataTableColumnHeaderProps<TData, TValue>
  extends React.HTMLAttributes<HTMLDivElement> {
  column: Column<TData, TValue>;
  title: string;
}

export function DataTableColumnDisplayHeader<TData, TValue>({
  title,
  className,
}: DataTableColumnHeaderProps<TData, TValue>) {
  return <div className={cn(className)}>{title}</div>;
}

// Add default export as well
export default DataTableColumnDisplayHeader;
