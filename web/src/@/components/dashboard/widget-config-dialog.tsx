"use client";

import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type WidgetConfig } from "@/types/dashboard";
import { widgetRegistry } from "@/lib/widget-registry";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { X } from "lucide-react";

interface WidgetConfigDialogProps {
  widget: WidgetConfig | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (config: WidgetConfig) => void;
}

export function WidgetConfigDialog({
  widget,
  open,
  onOpenChange,
  onSave,
}: WidgetConfigDialogProps) {
  const [config, setConfig] = useState<WidgetConfig | null>(widget);

  // Update config when widget prop changes
  React.useEffect(() => {
    if (widget) {
      setConfig(widget);
    } else {
      setConfig(null);
    }
  }, [widget]);

  const handleSave = () => {
    if (config) {
      onSave(config);
    }
  };

  if (!config || !widget) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configure Widget</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground">No widget selected</p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const definition = widgetRegistry.getDefinition(config.type);
  const schema = definition?.configSchema as {
    type?: string;
    properties?: Record<string, Record<string, unknown>>;
  } | undefined;

  const updateSetting = (key: string, value: unknown) => {
    setConfig({
      ...config,
      settings: {
        ...config.settings,
        [key]: value,
      },
    });
  };

  const renderField = (key: string, fieldSchema: Record<string, unknown>) => {
    const value = config.settings?.[key] ?? (fieldSchema.default as string | number | string[] | boolean);

    if (fieldSchema.type === "boolean") {
      return (
        <div key={key} className="flex items-center justify-between space-x-2">
          <Label htmlFor={key} className="flex-1">
            {(fieldSchema.description as string) ?? key.replace(/([A-Z])/g, " $1").trim()}
          </Label>
          <Switch
            id={key}
            checked={value as boolean}
            onCheckedChange={(checked) => updateSetting(key, checked)}
          />
        </div>
      );
    }

    if (fieldSchema.enum) {
      return (
        <div key={key} className="space-y-2">
          <Label>{key.replace(/([A-Z])/g, " $1").trim()}</Label>
          <Select value={value as string} onValueChange={(v) => updateSetting(key, v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(fieldSchema.enum as string[]).map((option: string) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    }

    if (fieldSchema.type === "number") {
      return (
        <div key={key} className="space-y-2">
          <Label>{key.replace(/([A-Z])/g, " $1").trim()}</Label>
          <Input
            type="number"
            value={value as number}
            onChange={(e) => updateSetting(key, parseInt(e.target.value))}
            min={fieldSchema.minimum as number}
            max={fieldSchema.maximum as number}
          />
        </div>
      );
    }

    if (fieldSchema.type === "array" && key === "stocks") {
      const stocks = (value as string[]) || [];
      return (
        <div key={key} className="space-y-2">
          <Label>Stocks</Label>
          <div className="flex flex-wrap gap-2 mb-2">
            {stocks.map((stock, index) => (
              <Badge key={index} variant="secondary" className="pl-2">
                {stock}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-4 w-4 ml-1"
                  onClick={() => {
                    const newStocks = stocks.filter((_, i) => i !== index);
                    updateSetting(key, newStocks);
                  }}
                >
                  <X className="h-3 w-3" />
                </Button>
              </Badge>
            ))}
          </div>
          <Input
            placeholder="Add stock code (e.g., CBA)"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const input = e.currentTarget;
                const stockCode = input.value.toUpperCase().trim();
                if (stockCode && !stocks.includes(stockCode)) {
                  updateSetting(key, [...stocks, stockCode]);
                  input.value = "";
                }
              }
            }}
          />
        </div>
      );
    }

    return (
      <div key={key} className="space-y-2">
        <Label>{key.replace(/([A-Z])/g, " $1").trim()}</Label>
        <Input
          value={value as string}
          onChange={(e) => updateSetting(key, e.target.value)}
        />
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure {config.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Widget Title</Label>
            <Input
              value={config.title}
              onChange={(e) =>
                setConfig({ ...config, title: e.target.value })
              }
            />
          </div>
          {schema?.properties ? (
            Object.entries(schema.properties).map(([key, fieldSchema]) =>
              renderField(key, fieldSchema)
            )
          ) : (
            <div className="text-sm text-muted-foreground">No configurable settings available</div>
          )}
          <div className="space-y-2">
            <Label>Refresh Interval (seconds)</Label>
            <Input
              type="number"
              value={config.dataSource.refreshInterval ?? 0}
              onChange={(e) =>
                setConfig({
                  ...config,
                  dataSource: {
                    ...config.dataSource,
                    refreshInterval: parseInt(e.target.value) || undefined,
                  },
                })
              }
              placeholder="0 = No auto-refresh"
              min={0}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}