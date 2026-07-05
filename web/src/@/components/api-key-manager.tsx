"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Copy,
  Key,
  RefreshCw,
  Check,
  Eye,
  EyeOff,
  AlertTriangle,
  Shield,
  Terminal,
} from "lucide-react";
import Image from "next/image";
import { mintApiTokenAction } from "~/app/actions/mintToken";

interface RateLimitTier {
  name: string;
  perMinute: string;
  perMonth: string;
}

const RATE_LIMIT_TIERS: { api: RateLimitTier[]; browser: RateLimitTier[] } = {
  api: [
    { name: "Anonymous", perMinute: "30", perMonth: "1,000" },
    { name: "Free", perMinute: "60", perMonth: "2,000" },
    { name: "Paid", perMinute: "Unlimited", perMonth: "10,000" },
  ],
  browser: [
    {
      name: "Anonymous",
      perMinute: "600 refill / 3,000 burst",
      perMonth: "Fair use",
    },
    { name: "Signed in", perMinute: "3,000", perMonth: "Fair use" },
  ],
};

function maskToken(token: string): string {
  if (token.length <= 8) return token;
  const visibleEnd = token.slice(-8);
  const maskedPart = "*".repeat(Math.min(token.length - 8, 32));
  return `${maskedPart}${visibleEnd}`;
}

export function ApiKeyManager() {
  const [token, setToken] = useState<string | null>(null);
  const [isRevealed, setIsRevealed] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasGenerated, setHasGenerated] = useState(false);

  const handleGenerateToken = useCallback(async () => {
    setIsGenerating(true);
    setError(null);

    try {
      const result = await mintApiTokenAction();
      setToken(result.token);
      setHasGenerated(true);
      setIsRevealed(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate token.",
      );
    } finally {
      setIsGenerating(false);
    }
  }, []);

  const handleCopy = useCallback(async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = token;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  }, [token]);

  return (
    <div className="space-y-6">
      {/* Token Generation Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Image
              src="/assets/api-access-small.png"
              alt=""
              width={40}
              height={40}
              className="h-10 w-10"
            />
            <div>
              <CardTitle className="text-xl">API Token</CardTitle>
              <CardDescription>
                Generate a token to authenticate your API requests
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {token ? (
            <div className="space-y-4">
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Save your token</AlertTitle>
                <AlertDescription>
                  This token will only be shown once. Copy it now and store it
                  securely. If you lose it, you will need to generate a new one.
                </AlertDescription>
              </Alert>

              <div className="flex items-center gap-2">
                <div className="flex-1 relative">
                  <code className="block w-full rounded-md border border-border bg-muted/50 px-4 py-3 font-mono text-sm break-all">
                    {isRevealed ? token : maskToken(token)}
                  </code>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setIsRevealed(!isRevealed)}
                    title={isRevealed ? "Hide token" : "Reveal token"}
                  >
                    {isRevealed ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleCopy}
                    title="Copy to clipboard"
                  >
                    {isCopied ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              <Button
                variant="outline"
                onClick={handleGenerateToken}
                disabled={isGenerating}
                className="gap-2"
              >
                <RefreshCw
                  className={`h-4 w-4 ${isGenerating ? "animate-spin" : ""}`}
                />
                Regenerate Token
              </Button>
              {hasGenerated && (
                <p className="text-xs text-muted-foreground">
                  Regenerating will invalidate your previous token.
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-start gap-4">
              <p className="text-sm text-muted-foreground">
                You have not generated an API token yet. Click the button below
                to create one.
              </p>
              <Button
                onClick={handleGenerateToken}
                disabled={isGenerating}
                className="gap-2"
              >
                {isGenerating ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Key className="h-4 w-4" />
                )}
                {isGenerating ? "Generating..." : "Generate API Token"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Rate Limits Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Image
              src="/assets/premium-icon-small.png"
              alt=""
              width={40}
              height={40}
              className="h-10 w-10"
            />
            <div>
              <CardTitle className="text-xl">Rate Limits</CardTitle>
              <CardDescription>
                Request limits based on your subscription tier
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* API Access */}
          <div>
            <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Terminal className="h-4 w-4 text-muted-foreground" />
              API Access
              <Badge variant="secondary" className="text-xs">
                Token Auth
              </Badge>
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 pr-4 font-medium text-muted-foreground">
                      Tier
                    </th>
                    <th className="text-left py-2 pr-4 font-medium text-muted-foreground">
                      Per Minute
                    </th>
                    <th className="text-left py-2 font-medium text-muted-foreground">
                      Per Month
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {RATE_LIMIT_TIERS.api.map((tier) => (
                    <tr key={tier.name} className="border-b border-border/50">
                      <td className="py-2 pr-4 font-medium">{tier.name}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {tier.perMinute}
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {tier.perMonth}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Browser Access */}
          <div>
            <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              Browser Access
              <Badge variant="secondary" className="text-xs">
                Session Auth
              </Badge>
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 pr-4 font-medium text-muted-foreground">
                      Tier
                    </th>
                    <th className="text-left py-2 pr-4 font-medium text-muted-foreground">
                      Per Minute
                    </th>
                    <th className="text-left py-2 font-medium text-muted-foreground">
                      Per Month
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {RATE_LIMIT_TIERS.browser.map((tier) => (
                    <tr key={tier.name} className="border-b border-border/50">
                      <td className="py-2 pr-4 font-medium">{tier.name}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {tier.perMinute}
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {tier.perMonth}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Rate limit headers are included in all API responses. When limits
            are exceeded, requests return HTTP 429 with a Retry-After header.
          </p>
        </CardContent>
      </Card>

      {/* Usage Examples Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Terminal className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-xl">Usage Examples</CardTitle>
              <CardDescription>
                How to authenticate your API requests
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <h4 className="text-sm font-semibold mb-2">
              Using the Authorization header
            </h4>
            <CodeBlock
              code={`curl -H "Authorization: Bearer YOUR_API_TOKEN" \\
  https://shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetTopShorts`}
            />
          </div>

          <div>
            <h4 className="text-sm font-semibold mb-2">
              Fetching top shorted stocks
            </h4>
            <CodeBlock
              code={`curl -X POST \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"limit": 10, "period": "3m"}' \\
  https://shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetTopShorts`}
            />
          </div>

          <div>
            <h4 className="text-sm font-semibold mb-2">
              Getting stock details
            </h4>
            <CodeBlock
              code={`curl -X POST \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"product_code": "BHP"}' \\
  https://shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetStock`}
            />
          </div>

          <div>
            <h4 className="text-sm font-semibold mb-2">Response headers</h4>
            <p className="text-sm text-muted-foreground mb-2">
              All responses include rate limit information:
            </p>
            <CodeBlock
              code={`X-RateLimit-Limit: 60
X-RateLimit-Remaining: 55
X-RateLimit-Reset: 1706918400
X-RateLimit-Monthly-Limit: 10000
X-RateLimit-Monthly-Used: 150
X-RateLimit-Monthly-Reset: 1709251200`}
            />
          </div>

          <p className="text-sm text-muted-foreground">
            For full API documentation, visit the{" "}
            <a
              href="/docs/api"
              className="text-primary underline underline-offset-4 hover:text-primary/80"
            >
              API Reference
            </a>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const textArea = document.createElement("textarea");
      textArea.value = code;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="relative group">
      <pre className="rounded-md border border-border bg-muted/50 p-4 font-mono text-sm overflow-x-auto">
        <code>{code}</code>
      </pre>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={handleCopy}
        title="Copy code"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}
