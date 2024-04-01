"use client";

import { ColumnDef, flexRender } from "@tanstack/react-table";

import { Badge } from "@/components/ui/badge";

import { priorities, statuses } from "../data/data";
import { DataTableColumnHeader } from "./data-table-column-header";
import { DataTableColumnDisplayHeader } from "./data-table-column-display-header";
import { PlainMessage } from "@bufbuild/protobuf";
import { TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import Sparkline from "./sparkline";

export const columns: ColumnDef<PlainMessage<TimeSeriesData>>[] = [
  {
    id: "name",
    accessorKey: "productCode",
    header: ({ column }) => (
      <DataTableColumnDisplayHeader column={column} title="Name" />
    ),
    cell: ({ row }) => {
      return (
        <Card className="border-hidden bg-transparent shadow-none">
          <CardHeader>
            <CardTitle>{row.original.productCode}</CardTitle>
            <CardDescription>{row.original.name}</CardDescription>
          </CardHeader>
        </Card>
      );
    },
    enableSorting: false,
    enableHiding: false,
  },
  {
    id: "shorted",
    header: ({ table }) => <div>Short %</div>,
    cell: ({ row }) => <div>{row.original.points.at(-1)?.shortPosition}</div>,
    enableSorting: false,
    enableHiding: false,
  },
  {
    id: "sparkline",
    header: ({ table }) => <div>last 6 months</div>,
    cell: ({ row }) => flexRender(Sparkline, {data: row.original}),
    enableSorting: false,
    enableHiding: false,
  },
  //   {
  //     accessorKey: "title",
  //     header: ({ column }) => (
  //       <DataTableColumnHeader column={column} title="Title" />
  //     ),
  //     cell: ({ row }) => {
  //       const label = labels.find((label) => label.value === row.original.label);

  //       return (
  //         <div className="flex space-x-2">
  //           {label && <Badge variant="outline">{label.label}</Badge>}
  //           <span className="max-w-[500px] truncate font-medium">
  //             {row.getValue("title")}
  //           </span>
  //         </div>
  //       );
  //     },
  //   },
  //   {
  //     accessorKey: "status",
  //     header: ({ column }) => (
  //       <DataTableColumnHeader column={column} title="Status" />
  //     ),
  //     cell: ({ row }) => {
  //       const status = statuses.find(
  //         (status) => status.value === row.getValue("status"),
  //       );

  //       if (!status) {
  //         return null;
  //       }

  //       return (
  //         <div className="flex w-[100px] items-center">
  //           {status.icon && (
  //             <status.icon className="mr-2 h-4 w-4 text-muted-foreground" />
  //           )}
  //           <span>{status.label}</span>
  //         </div>
  //       );
  //     },
  //     filterFn: (row, id, value) => {
  //       return value.includes(row.getValue(id));
  //     },
  //   },
  //   {
  //     accessorKey: "priority",
  //     header: ({ column }) => (
  //       <DataTableColumnHeader column={column} title="Priority" />
  //     ),
  //     cell: ({ row }) => {
  //       const priority = priorities.find(
  //         (priority) => priority.value === row.getValue("priority"),
  //       );

  //       if (!priority) {
  //         return null;
  //       }

  //       return (
  //         <div className="flex items-center">
  //           {priority.icon && (
  //             <priority.icon className="mr-2 h-4 w-4 text-muted-foreground" />
  //           )}
  //           <span>{priority.label}</span>
  //         </div>
  //       );
  //     },
  //     filterFn: (row, id, value) => {
  //       return value.includes(row.getValue(id));
  //     },
  //   },
  //   {
  //     id: "actions",
  //     cell: ({ row }) => <DataTableRowActions row={row} />,
  //   },
];