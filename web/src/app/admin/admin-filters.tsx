"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RefreshCw } from "lucide-react";

interface AdminFiltersProps {
  currentEnvironment: string;
  showLocal: boolean;
}

export function AdminFilters({
  currentEnvironment,
  showLocal,
}: AdminFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const updateFilters = (updates: { environment?: string; showLocal?: boolean }) => {
    const params = new URLSearchParams(searchParams.toString());
    
    if (updates.environment !== undefined) {
      if (updates.environment === "production") {
        params.delete("environment"); // production is default
      } else {
        params.set("environment", updates.environment);
      }
    }
    
    if (updates.showLocal !== undefined) {
      if (updates.showLocal) {
        params.set("showLocal", "true");
      } else {
        params.delete("showLocal");
      }
    }
    
    router.push(`/admin?${params.toString()}`);
  };

  const handleRefresh = () => {
    router.refresh();
  };

  return (
    <div className="flex flex-wrap items-center gap-4 p-4 rounded-lg border bg-muted/30">
      <div className="flex items-center gap-2">
        <Label htmlFor="environment-select" className="text-sm font-medium">
          Environment:
        </Label>
        <Select
          value={currentEnvironment}
          onValueChange={(value) => updateFilters({ environment: value })}
        >
          <SelectTrigger id="environment-select" className="w-[160px]">
            <SelectValue placeholder="Select environment" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="production">Production</SelectItem>
            <SelectItem value="development">Development</SelectItem>
            <SelectItem value="all">All Environments</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="show-local"
          checked={showLocal}
          onCheckedChange={(checked) => updateFilters({ showLocal: checked })}
        />
        <Label htmlFor="show-local" className="text-sm cursor-pointer">
          Show local runs
        </Label>
      </div>

      <div className="ml-auto">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          className="gap-1.5"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>
    </div>
  );
}

