"use client";

import { useSession } from "next-auth/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { triggerEnrichmentAction } from "~/app/actions/triggerEnrichment";
import { Loader2 } from "lucide-react";

interface EnrichmentTriggerProps {
  stockCode: string;
}

export function EnrichmentTrigger({ stockCode }: EnrichmentTriggerProps) {
  const { data: session } = useSession();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  if (!session?.user?.isAdmin) {
    return null;
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccessMessage(null);
    setJobId(null);

    const formData = new FormData(e.currentTarget);
    formData.set("stockCode", stockCode);

    try {
      const result = await triggerEnrichmentAction(formData);
      if (result?.success && result.jobId) {
        setJobId(result.jobId);
        setSuccessMessage(result?.message || `Job ${result.jobId} created successfully`);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to trigger enrichment",
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card className="border-dashed border-purple-300 dark:border-purple-800">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <span className="text-purple-600 dark:text-purple-400">Admin:</span>
          Trigger Enrichment
        </CardTitle>
        <CardDescription className="text-xs">
          Start a new enrichment for this stock
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input type="hidden" name="stockCode" value={stockCode} />
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`force-${stockCode}`}
              name="force"
              value="true"
              className="h-4 w-4 rounded border-gray-300"
            />
            <Label
              htmlFor={`force-${stockCode}`}
              className="text-xs cursor-pointer"
            >
              Force re-enrichment (even if already enriched)
            </Label>
          </div>
          {error && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 p-2 rounded">
              {error}
            </div>
          )}
          {successMessage && (
            <div className="text-xs text-green-600 dark:text-green-400 bg-green-50 dark:green-950/20 p-2 rounded">
              {successMessage}
              {jobId && (
                <div className="mt-1 text-xs opacity-75">
                  Job ID: {jobId}
                </div>
              )}
            </div>
          )}
          <Button
            type="submit"
            size="sm"
            className="w-full"
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Triggering...
              </>
            ) : (
              "Trigger Enrichment"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

