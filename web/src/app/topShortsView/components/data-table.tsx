"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import { Button } from "~/@/components/ui/button";
import { Skeleton } from "~/@/components/ui/skeleton";
import { debounce } from "lodash";

interface DataTableProps<TData, TValue> {
  loading: boolean;
  columns: ColumnDef<TData, TValue>[];
  period: string;
  data: TData[];
  fetchMore: () => Promise<void>;
}

export function DataTable<TData, TValue>({
  columns,
  period,
  data,
  fetchMore,
  loading,
}: DataTableProps<TData, TValue>) {
  const [localData, setLocalData] = React.useState(data);
  const [, setIsLoading] = React.useState(loading);
  const [isLargeScreen, setIsLargeScreen] = React.useState(false);
  const [showLoadMore, setShowLoadMore] = React.useState(false);
  const [, setIsFetching] = React.useState(false);
  const fetchingRef = React.useRef(false);
  const totalRowsMax = 100; // Define this constant or make it a prop

  React.useEffect(() => {
    const checkScreenSize = () => {
      setIsLargeScreen(window.innerWidth >= 1024);
    };

    checkScreenSize();
    window.addEventListener("resize", checkScreenSize);

    return () => window.removeEventListener("resize", checkScreenSize);
  }, []);

  React.useEffect(() => {
    setLocalData(data);
    setIsLoading(loading);
    setIsFetching(false);
    fetchingRef.current = false;
  }, [data, loading]);

  React.useEffect(() => {
    setShowLoadMore(!isLargeScreen && localData.length < totalRowsMax);
  }, [isLargeScreen, localData.length, totalRowsMax]);

  const [columnVisibility, setColumnVisibility] =
    React.useState<VisibilityState>({});
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    [],
  );
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const router = useRouter();

  const table = useReactTable({
    data: localData,
    columns,
    state: {
      sorting,
      columnVisibility,
      columnFilters,
    },
    enableRowSelection: true,
    columnResizeMode: "onChange",
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    defaultColumn: {
      minSize: 100,
      maxSize: 400,
    },
  });

  const parentRef = React.useRef<HTMLDivElement>(null);
  const { rows } = table.getRowModel();

  const debouncedFetchMore = React.useMemo(
    () =>
      debounce(() => {
        if (!fetchingRef.current && localData.length < totalRowsMax) {
          fetchingRef.current = true;
          setIsFetching(true);
          fetchMore()
            .catch((error) => {
              console.error("Error fetching more data:", error);
            })
            .finally(() => {
              fetchingRef.current = false;
              setIsFetching(false);
            });
        }
      }, 200),
    [fetchMore, localData.length, totalRowsMax],
  );

  const fetchMoreOnBottomReached = React.useCallback(
    (containerRefElement?: HTMLDivElement | null) => {
      if (containerRefElement && isLargeScreen) {
        const { scrollHeight, scrollTop, clientHeight } = containerRefElement;
        if (scrollHeight - scrollTop - clientHeight < 300) {
          debouncedFetchMore();
        }
      }
    },
    [debouncedFetchMore, isLargeScreen],
  );

  React.useEffect(() => {
    const currentRef = parentRef.current;
    if (currentRef && isLargeScreen) {
      const scrollHandler = () => fetchMoreOnBottomReached(currentRef);
      currentRef.addEventListener("scroll", scrollHandler);
      return () => {
        currentRef.removeEventListener("scroll", scrollHandler);
      };
    }
  }, [fetchMoreOnBottomReached, isLargeScreen]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length + (showLoadMore ? 1 : 0),
    getScrollElement: () => parentRef.current,
    estimateSize: () => 183,
    measureElement:
      typeof window !== "undefined" &&
      navigator.userAgent.indexOf("Firefox") === -1
        ? (element) => element?.getBoundingClientRect().height
        : undefined,
    overscan: 5,
  });

  React.useEffect(() => {
    rowVirtualizer.measure();
  }, [localData, rowVirtualizer]);

  const [isLoadingMore, setIsLoadingMore] = React.useState(false);

  const handleLoadMore = React.useCallback(() => {
    if (!fetchingRef.current && !isLoadingMore) {
      fetchingRef.current = true;
      setIsLoadingMore(true);
      fetchMore()
        .catch((error) => {
          console.error("Error fetching more data:", error);
        })
        .finally(() => {
          setIsLoadingMore(false);
          fetchingRef.current = false;
        });
    }
  }, [fetchMore, isLoadingMore]);

  return (
    <div className="h-[700px] w-full flex flex-col">
      <div
        ref={parentRef}
        className="flex-grow overflow-x-hidden overflow-y-auto"
        onScroll={() => fetchMoreOnBottomReached(parentRef.current)}
      >
        <Table className="w-full table-fixed">
          <TableHeader className="sticky top-0 z-10 bg-background">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="flex">
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    className="flex-1 min-w-0 p-2 text-xs text-center"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.id == "sparkline"
                            ? ({}) => (
                                <div className="flex h-full justify-center items-center">{`Last ${period}`}</div>
                              )
                            : header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              // Show skeleton loader while data is being fetched
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`skeleton-${i}`} className="flex w-full">
                  {columns.map((_, colIndex) => (
                    <TableCell
                      key={`skeleton-cell-${i}-${colIndex}`}
                      className="flex-1 min-w-0 p-2"
                    >
                      <Skeleton className="h-[160px] w-full rounded-lg" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow className="w-full">
                <TableCell
                  colSpan={columns.length}
                  className="h-[100px] flex justify-center items-center text-center"
                >
                  <p>No data found, try a different time</p>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  onClick={() =>
                    router.push(
                      `/shorts/${(row.original as { productCode: string }).productCode}`,
                    )
                  }
                  className="flex w-full cursor-pointer items-center"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className="flex-1 min-w-0 p-2 text-sm overflow-hidden items-center"
                    >
                      <div className="truncate">
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </div>
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {showLoadMore && rows.length > 0 && (
        <Button
          onClick={handleLoadMore}
          disabled={isLoadingMore}
          className="my-4 w-full"
        >
          {isLoadingMore ? "Loading..." : "Load More"}
        </Button>
      )}
    </div>
  );
}
