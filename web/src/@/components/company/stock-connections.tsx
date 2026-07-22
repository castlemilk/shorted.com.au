"use client";

import { useQuery } from "@tanstack/react-query";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Badge } from "~/@/components/ui/badge";
import { Network } from "lucide-react";
import Link from "next/link";

interface StockConnectionsProps {
  stockCode: string;
  limit?: number;
}

/**
 * Semantically similar companies from the knowledge graph. Leadership
 * edges are intentionally NOT shown here — key people already render in
 * the Company insights card on the same tab.
 */
export function StockConnections({
  stockCode,
  limit = 12,
}: StockConnectionsProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["stock-graph", stockCode, limit],
    queryFn: async () => {
      const transport = createConnectTransport({ baseUrl: "" });
      const client = createClient(StockService, transport);
      return client.getStockGraph({ stockCode, limit });
    },
    staleTime: 10 * 60 * 1000,
  });

  // Below the fold + frequently empty: render nothing while loading rather
  // than flashing a skeleton card that may unmount to null.
  if (isLoading) return null;

  const similarCompanies = data?.similarCompanies ?? [];
  if (similarCompanies.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Network className="h-5 w-5" />
          Similar companies
        </CardTitle>
        <CardDescription>
          Semantic peers from the knowledge graph
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {similarCompanies.map((peer) => (
            <Link
              key={peer.stockCode}
              href={`/shorts/${peer.stockCode}`}
              className="block group"
            >
              <div className="flex items-center justify-between gap-3 p-2.5 rounded-lg hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-sm font-semibold text-primary group-hover:underline shrink-0">
                    {peer.stockCode}
                  </span>
                  <span className="text-sm text-muted-foreground truncate">
                    {peer.companyName}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {peer.industry && (
                    // Hidden on the smallest viewports: an unbounded industry
                    // badge in this shrink-0 cluster otherwise squeezes the
                    // company name to nothing at ~360px.
                    <Badge
                      variant="secondary"
                      className="hidden sm:inline-flex text-[11px] py-0"
                    >
                      {peer.industry}
                    </Badge>
                  )}
                  {peer.similarity > 0 && (
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {Math.round(peer.similarity * 100)}% match
                    </span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
