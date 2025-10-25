"use client";

import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Plus,
  Trash2,
  TrendingUp,
  DollarSign,
  Target,
  BarChart3,
  Loader2,
} from "lucide-react";
import { StockAutocomplete } from "@/components/ui/stock-autocomplete";
import {
  getMultipleStockQuotes,
  type StockQuote,
} from "@/lib/stock-data-service";
// import { useAsyncErrorHandler } from "@/hooks/use-async-error";
import {
  portfolioService,
  type PortfolioHolding,
} from "@/lib/portfolio-service";
import { useSession } from "next-auth/react";
import { useToast } from "@/hooks/use-toast";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

interface PortfolioData {
  holdings: PortfolioHolding[];
  totalValue: number;
  totalCost: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  topPerformer: { symbol: string; gainLoss: number; percent: number } | null;
  worstPerformer: { symbol: string; gainLoss: number; percent: number } | null;
}

export default function PortfolioPage() {
  const { data: session } = useSession();
  const { toast } = useToast();
  const [holdings, setHoldings] = useState<PortfolioHolding[]>([]);
  const [quotes, setQuotes] = useState<Map<string, StockQuote>>(new Map());
  const [portfolioData, setPortfolioData] = useState<PortfolioData | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [newHolding, setNewHolding] = useState({
    symbol: "",
    shares: "",
    averagePrice: "",
  });
  // const handleAsyncError = useAsyncErrorHandler(); // Currently unused

  // Load portfolio from Firebase on mount
  useEffect(() => {
    const loadPortfolio = async () => {
      if (!session?.user?.id) {
        setLoading(false);
        return;
      }

      try {
        const portfolio = await portfolioService.getPortfolio();
        setHoldings(portfolio.holdings as PortfolioHolding[]);

        // One-time migration from localStorage if needed
        await portfolioService.migrateFromLocalStorage();
      } catch (error) {
        console.error("Failed to load portfolio:", error);
        toast({
          title: "Error loading portfolio",
          description: "Failed to load your portfolio from the server",
          variant: "destructive",
        });
      }
    };

    void loadPortfolio();
  }, [session, toast]);

  // Fetch stock quotes and calculate portfolio data
  useEffect(() => {
    const fetchPortfolioData = async () => {
      if (holdings.length === 0) {
        setLoading(false);
        return;
      }

      setLoading(true);

      try {
        const symbols = holdings.map((h) => h.symbol);
        const stockQuotes = await getMultipleStockQuotes(symbols);
        setQuotes(stockQuotes);

        let totalValue = 0;
        let totalCost = 0;
        let topPerformer: {
          symbol: string;
          gainLoss: number;
          percent: number;
        } | null = null;
        let worstPerformer: {
          symbol: string;
          gainLoss: number;
          percent: number;
        } | null = null;

        holdings.forEach((holding) => {
          const quote = stockQuotes.get(holding.symbol);
          if (quote) {
            const currentValue = quote.price * holding.shares;
            const cost = holding.averagePrice * holding.shares;
            const gainLoss = currentValue - cost;
            const gainLossPercent = (gainLoss / cost) * 100;

            totalValue += currentValue;
            totalCost += cost;

            if (!topPerformer || gainLossPercent > topPerformer.percent) {
              topPerformer = {
                symbol: holding.symbol,
                gainLoss,
                percent: gainLossPercent,
              };
            }
            if (!worstPerformer || gainLossPercent < worstPerformer.percent) {
              worstPerformer = {
                symbol: holding.symbol,
                gainLoss,
                percent: gainLossPercent,
              };
            }
          }
        });

        const totalGainLoss = totalValue - totalCost;
        const totalGainLossPercent =
          totalCost > 0 ? (totalGainLoss / totalCost) * 100 : 0;

        setPortfolioData({
          holdings,
          totalValue,
          totalCost,
          totalGainLoss,
          totalGainLossPercent,
          topPerformer,
          worstPerformer,
        });
      } catch (error) {
        console.error("Failed to fetch portfolio data:", error);
        setQuotes(new Map()); // Clear quotes
        setPortfolioData(null); // Clear portfolio data

        toast({
          title: "Market data unavailable",
          description:
            "Unable to fetch current stock prices. Portfolio values may not be current.",
          variant: "destructive",
        });
      }

      setLoading(false);
    };

    void fetchPortfolioData();

    // Refresh every 5 minutes
    const interval = setInterval(
      () => void fetchPortfolioData(),
      5 * 60 * 1000,
    );
    return () => clearInterval(interval);
  }, [holdings, toast]);

  const handleAddStock = async () => {
    if (!session?.user?.id) {
      toast({
        title: "Authentication required",
        description: "Please sign in to manage your portfolio",
        variant: "destructive",
      });
      return;
    }

    if (!newHolding.symbol || !newHolding.shares || !newHolding.averagePrice) {
      return;
    }

    setSaving(true);
    try {
      const holding: PortfolioHolding = {
        symbol: newHolding.symbol.toUpperCase(),
        shares: parseInt(newHolding.shares),
        averagePrice: parseFloat(newHolding.averagePrice),
      };

      await portfolioService.addHolding(holding);

      // Reload portfolio
      const portfolio = await portfolioService.getPortfolio();
      setHoldings(portfolio.holdings as PortfolioHolding[]);

      setNewHolding({ symbol: "", shares: "", averagePrice: "" });
      setAddDialogOpen(false);

      toast({
        title: "Stock added",
        description: `${holding.symbol} has been added to your portfolio`,
      });
    } catch (error) {
      console.error("Failed to add stock:", error);
      toast({
        title: "Error",
        description: "Failed to add stock to portfolio",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveStock = async (symbol: string) => {
    if (!session?.user?.id) {
      toast({
        title: "Authentication required",
        description: "Please sign in to manage your portfolio",
        variant: "destructive",
      });
      return;
    }

    try {
      await portfolioService.removeHolding(symbol);

      // Reload portfolio
      const portfolio = await portfolioService.getPortfolio();
      setHoldings(portfolio.holdings as PortfolioHolding[]);

      toast({
        title: "Stock removed",
        description: `${symbol} has been removed from your portfolio`,
      });
    } catch (error) {
      console.error("Failed to remove stock:", error);
      toast({
        title: "Error",
        description: "Failed to remove stock from portfolio",
        variant: "destructive",
      });
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatPercent = (value: number) => {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  };

  if (!session) {
    return (
      <DashboardLayout>
        <Card className="p-8 text-center">
          <h2 className="text-xl font-semibold mb-4">Sign in Required</h2>
          <p className="text-muted-foreground">
            Please sign in to view and manage your portfolio
          </p>
        </Card>
      </DashboardLayout>
    );
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <Skeleton className="h-12 w-64" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[...(Array(4) as undefined[])].map((_, i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
          <Skeleton className="h-96" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">My Portfolio</h1>
          <p className="text-muted-foreground mt-2">
            Track your stock holdings and performance
          </p>
        </div>
        <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Stock
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Stock to Portfolio</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-4">
              <div>
                <Label htmlFor="symbol">Stock Symbol</Label>
                <StockAutocomplete
                  value={newHolding.symbol}
                  onChange={(value) =>
                    setNewHolding({ ...newHolding, symbol: value })
                  }
                  onSelect={(stock) => {
                    setNewHolding({ ...newHolding, symbol: stock.code });
                    // Auto-focus on shares input after selection
                    setTimeout(() => {
                      const sharesInput = document.getElementById(
                        "shares",
                      ) as HTMLInputElement;
                      sharesInput?.focus();
                    }, 100);
                  }}
                  placeholder="Search for a stock (e.g. CBA)"
                />
              </div>
              <div>
                <Label htmlFor="shares">Number of Shares</Label>
                <Input
                  id="shares"
                  type="number"
                  placeholder="100"
                  value={newHolding.shares}
                  onChange={(e) =>
                    setNewHolding({ ...newHolding, shares: e.target.value })
                  }
                />
              </div>
              <div>
                <Label htmlFor="price">Average Purchase Price</Label>
                <Input
                  id="price"
                  type="number"
                  step="0.01"
                  placeholder="95.50"
                  value={newHolding.averagePrice}
                  onChange={(e) =>
                    setNewHolding({
                      ...newHolding,
                      averagePrice: e.target.value,
                    })
                  }
                />
              </div>
              <Button
                onClick={handleAddStock}
                className="w-full"
                disabled={
                  saving ||
                  !newHolding.symbol ||
                  !newHolding.shares ||
                  !newHolding.averagePrice
                }
              >
                {saving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Adding...
                  </>
                ) : (
                  "Add to Portfolio"
                )}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {(portfolioData ?? (holdings.length > 0 && !loading)) && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <Card className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Value</p>
                  <p className="text-2xl font-bold">
                    {portfolioData
                      ? formatCurrency(portfolioData.totalValue)
                      : "—"}
                  </p>
                  {!portfolioData && (
                    <p className="text-xs text-muted-foreground">
                      Market data unavailable
                    </p>
                  )}
                </div>
                <DollarSign className="h-8 w-8 text-muted-foreground" />
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Total Gain/Loss
                  </p>
                  {portfolioData ? (
                    <>
                      <p
                        className={`text-2xl font-bold ${portfolioData.totalGainLoss >= 0 ? "text-green-600" : "text-red-600"}`}
                      >
                        {formatCurrency(Math.abs(portfolioData.totalGainLoss))}
                      </p>
                      <p
                        className={`text-sm ${portfolioData.totalGainLossPercent >= 0 ? "text-green-600" : "text-red-600"}`}
                      >
                        {formatPercent(portfolioData.totalGainLossPercent)}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-2xl font-bold">—</p>
                      <p className="text-xs text-muted-foreground">
                        Market data unavailable
                      </p>
                    </>
                  )}
                </div>
                <BarChart3 className="h-8 w-8 text-muted-foreground" />
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Holdings Count
                  </p>
                  <p className="text-2xl font-bold">{holdings.length}</p>
                  <p className="text-xs text-muted-foreground">
                    Total positions
                  </p>
                </div>
                <Target className="h-8 w-8 text-muted-foreground" />
              </div>
            </Card>

            {portfolioData?.topPerformer ? (
              <Card className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">
                      Best Performer
                    </p>
                    <p className="text-lg font-bold">
                      {portfolioData.topPerformer.symbol}
                    </p>
                    <p className="text-sm text-green-600">
                      {formatPercent(portfolioData.topPerformer.percent)}
                    </p>
                  </div>
                  <TrendingUp className="h-8 w-8 text-green-600" />
                </div>
              </Card>
            ) : (
              <Card className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">
                      Total Cost Basis
                    </p>
                    <p className="text-2xl font-bold">
                      {formatCurrency(
                        holdings.reduce(
                          (total, h) => total + h.averagePrice * h.shares,
                          0,
                        ),
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Purchase value
                    </p>
                  </div>
                  <DollarSign className="h-8 w-8 text-muted-foreground" />
                </div>
              </Card>
            )}
          </div>

          {/* Holdings Table */}
          <Card>
            <ScrollArea className="h-[600px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead className="text-right">Shares</TableHead>
                    <TableHead className="text-right">Avg Price</TableHead>
                    <TableHead className="text-right">Current Price</TableHead>
                    <TableHead className="text-right">Market Value</TableHead>
                    <TableHead className="text-right">Gain/Loss</TableHead>
                    <TableHead className="text-right">% Change</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {holdings.map((holding) => {
                    const quote = quotes.get(holding.symbol);
                    const cost = holding.averagePrice * holding.shares;

                    return (
                      <TableRow key={holding.symbol}>
                        <TableCell className="font-medium">
                          {holding.symbol}
                        </TableCell>
                        <TableCell className="text-right">
                          {holding.shares}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(holding.averagePrice)}
                        </TableCell>
                        <TableCell className="text-right">
                          {quote ? formatCurrency(quote.price) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {quote
                            ? formatCurrency(quote.price * holding.shares)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {quote ? (
                            <span
                              className={`${quote.price * holding.shares - cost >= 0 ? "text-green-600" : "text-red-600"}`}
                            >
                              {formatCurrency(
                                Math.abs(quote.price * holding.shares - cost),
                              )}
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {quote ? (
                            <Badge
                              variant={
                                ((quote.price * holding.shares - cost) / cost) *
                                  100 >=
                                0
                                  ? "default"
                                  : "destructive"
                              }
                            >
                              {formatPercent(
                                ((quote.price * holding.shares - cost) / cost) *
                                  100,
                              )}
                            </Badge>
                          ) : (
                            <Badge variant="secondary">—</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveStock(holding.symbol)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </ScrollArea>
          </Card>
        </>
      )}

      {holdings.length === 0 && !loading && (
        <Card className="p-8 text-center">
          <p className="text-muted-foreground mb-4">
            Your portfolio is empty. Add some stocks to get started!
          </p>
          <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Your First Stock
              </Button>
            </DialogTrigger>
          </Dialog>
        </Card>
      )}
    </DashboardLayout>
  );
}
