"use client";

import { type ColumnDef, flexRender } from "@tanstack/react-table";
import { DataTableColumnDisplayHeader } from "./data-table-column-display-header";
import { type PlainMessage } from "@bufbuild/protobuf";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import Sparkline from "./sparkline";
import { Button } from "~/@/components/ui/button";
import { ArrowUpDown, Circle } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "~/@/components/ui/badge";

const redColor = `var(--red)`;
const greenColor = `var(--green)`;

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
    accessorKey: "latestShortPosition",
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Short
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      );
    },
    cell: ({ row }) => (
      <div className="grid w-m-60">
        <div className="">
          <Badge className="flex mb-1 mr-1 p-0 pl-1 items-center text-xs text-nowrap">
            <Circle strokeWidth={0} size={10} fill={greenColor} />
            <p className="pl-1">{`Min: ${row.original.min?.shortPosition.toFixed(2)}`}</p>
          </Badge>
          <Badge className="flex mr-1 p-0 pl-1 items-center text-xs text-nowrap">
            <Circle strokeWidth={0} size={10} fill={redColor} />
            <p className="pl-1">{`Max: ${row.original.max?.shortPosition.toFixed(2)}`}</p>
          </Badge>
        </div>
        <div className="flex items-end">
          <div className="text-3xl font-bold">
            {row.original.latestShortPosition.toFixed(2)}
          </div>
          <div className="text-lg ">%</div>
        </div>
      </div>
    ),
    enableSorting: true,
    enableHiding: false,
  },
  {
    id: "sparkline",
    header: ({}) => <div>last 6 months</div>,
    cell: ({ row }) =>
      flexRender(Sparkline, {
        data: row.original,
        key: `${row.id}-sparkline-chart`,
      }),
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

export const getColumns = (
  period: string,
): ColumnDef<PlainMessage<TimeSeriesData>>[] => {
  return useMemo(
    () => [
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
        accessorKey: "latestShortPosition",
        header: ({ column }) => {
          return (
            <Button
              variant="ghost"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Short
              <ArrowUpDown className="ml-2 h-4 w-4" />
            </Button>
          );
        },

        cell: ({ row }) => (
          <div className="flex">
            <div className="max-w-40">
              <div className="flex ml-4 p-1 items-center text-xs text-gray-400 ">
                <Circle strokeWidth={0} size={10} fill={greenColor} />
                <p className="pl-1">{`Min: ${row.original.min?.shortPosition.toFixed(2)}%`}</p>
              </div>
              <div className="flex  ml-4  p-1 items-center text-xs text-gray-400 o">
                <Circle strokeWidth={0} size={10} fill={redColor} />
                <p className="pl-1">{`Max: ${row.original.max?.shortPosition.toFixed(2)}%`}</p>
              </div>
            </div>
            <div className="flex items-end">
              <div className="text-3xl font-bold">
                {row.original.latestShortPosition.toFixed(2)}
              </div>
              <div className="text-lg ">%</div>
            </div>
          </div>
        ),
        enableSorting: true,
        enableHiding: false,
      },
      {
        id: "sparkline",
        header: ({}) => <div>{`Last ${getPeriodString(period)}`}</div>,
        cell: ({ row, cell }) =>
          flexRender(Sparkline, {
            data: row.original,
            width: cell.column.getSize(),
            key: `${row.id}-sparkline-${period}`,
          }),
        enableSorting: false,
        enableHiding: false,
        width: 150,
      },
    ],
    [period],
  );
};

const getPeriodString = (period: string) => {
  switch (period) {
    case "1m":
      return "1 month";
    case "3m":
      return "3 months";
    case "6m":
      return "6 months";
    case "1y":
      return "1 year";
    case "2y":
      return "2 years";
    case "max":
      return "maximum windoww";
    default:
      return "6 months";
  }
};
