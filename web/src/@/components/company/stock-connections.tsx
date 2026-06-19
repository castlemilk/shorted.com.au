"use client";

import { useQuery } from "@tanstack/react-query";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Badge } from "~/@/components/ui/badge";
import { Skeleton } from "~/@/components/ui/skeleton";
import { Users, Network, Linkedin } from "lucide-react";
import Link from "next/link";

interface StockConnectionsProps {
  stockCode: string;
  limit?: number;
}

export function StockConnections({
  stockCode,
  limit = 12,
}: StockConnectionsProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["stock-graph", stockCode, limit],
    queryFn: async () => {
      const transport = createConnectTransport({ baseUrl: "" });
      const client = createClient(ShortedStocksService, transport);
      return client.getStockGraph({ stockCode, limit });
    },
    staleTime: 10 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Network className="h-5 w-5" />
            Connections
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  const people = data?.people ?? [];
  const similarCompanies = data?.similarCompanies ?? [];

  if (people.length === 0 && similarCompanies.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Network className="h-5 w-5" />
          Connections
        </CardTitle>
        <CardDescription>
          Leadership links and semantically similar companies
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Leadership sub-section */}
        {people.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3 text-foreground">
              <Users className="h-4 w-4 text-muted-foreground" />
              Leadership
            </h3>
            <div className="space-y-3">
              {people.map((person, idx) => (
                <div
                  key={idx}
                  className="flex items-start justify-between gap-3 py-2 border-b last:border-b-0"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-medium">{person.name}</span>
                      {person.linkedinUrl && (
                        <a
                          href={person.linkedinUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`${person.name} on LinkedIn`}
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded bg-[#0A66C2] text-white hover:bg-[#004182] transition-colors"
                        >
                          <Linkedin className="h-2.5 w-2.5" />
                        </a>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {person.role}
                    </p>
                    {person.alsoAt.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">
                        also at:{" "}
                        {person.alsoAt.map((code, cIdx) => (
                          <span key={code}>
                            {cIdx > 0 && ", "}
                            <Link
                              href={`/shorts/${code}`}
                              className="font-mono font-medium text-primary hover:underline"
                            >
                              {code}
                            </Link>
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Similar companies sub-section */}
        {similarCompanies.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3 text-foreground">
              <Network className="h-4 w-4 text-muted-foreground" />
              Similar companies
            </h3>
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
                        <Badge variant="secondary" className="text-[11px] py-0">
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
          </div>
        )}
      </CardContent>
    </Card>
  );
}
