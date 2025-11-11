"use client";

import { useState, useCallback, useEffect } from "react";
import { useSession } from "next-auth/react";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { DashboardGrid } from "~/@/components/dashboard/dashboard-grid";
import { WidgetConfigDialog } from "~/@/components/dashboard/widget-config-dialog";
import { Button } from "~/@/components/ui/button";
import { Plus, Edit2, Save } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "~/@/components/ui/dropdown-menu";
import {
  type WidgetConfig,
  WidgetType,
  WidgetCategory,
} from "~/@/types/dashboard";
import { widgetRegistry } from "~/@/lib/widget-registry";
import { v4 as uuidv4 } from "uuid";
import { dashboardService } from "~/@/lib/dashboard-service";
import { useToast } from "~/@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { LoginRequired } from "~/@/components/auth/login-required";

// Bento-style layout with varied widget sizes for visual interest
const defaultWidgets: WidgetConfig[] = [
  {
    id: "1",
    type: WidgetType.TOP_SHORTS,
    title: "Top Shorted Stocks",
    dataSource: {
      endpoint: "/api/shorts/top",
      refreshInterval: 300,
    },
    layout: { x: 0, y: 0, w: 5, h: 12, minW: 4, minH: 6 },
    settings: { period: "3m", limit: 10 },
  },
  {
    id: "2",
    type: WidgetType.INDUSTRY_TREEMAP,
    title: "Industry Short Positions",
    dataSource: {
      endpoint: "/api/shorts/industry-treemap",
      refreshInterval: 300,
    },
    layout: { x: 5, y: 0, w: 7, h: 12, minW: 4, minH: 6 },
    settings: {
      period: "3m",
      viewMode: "CURRENT_CHANGE",
      showSectorGrouping: true,
    },
  },
];

export default function Dashboards() {
  const { data: session, status } = useSession();
  const { toast } = useToast();
  const [widgets, setWidgets] = useState<WidgetConfig[]>(defaultWidgets);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingWidget, setEditingWidget] = useState<WidgetConfig | null>(null);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [currentDashboardId, setCurrentDashboardId] = useState<string>(() => {
    // Generate a unique dashboard ID for new dashboards
    return `dashboard-${uuidv4()}`;
  });

  const handleAddWidget = useCallback((type: WidgetType) => {
    const definition = widgetRegistry.getDefinition(type);
    if (!definition) return;

    const newWidget: WidgetConfig = {
      id: uuidv4(),
      type,
      title: type
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (l) => l.toUpperCase()),
      dataSource: {
        endpoint: "/api/widgets/" + type.toLowerCase(),
      },
      layout: {
        x: 0,
        y: 0,
        w: definition.defaultLayout.w ?? 4,
        h: definition.defaultLayout.h ?? 4,
        ...definition.defaultLayout,
      },
      settings: {},
    };

    setWidgets((prev) => [...prev, newWidget]);
  }, []);

  const handleRemoveWidget = useCallback((widgetId: string) => {
    setWidgets((prev) => prev.filter((w) => w.id !== widgetId));
  }, []);

  const handleEditWidget = useCallback(
    (widgetId: string) => {
      const widget = widgets.find((w) => w.id === widgetId);
      if (widget) {
        setEditingWidget(widget);
        setConfigDialogOpen(true);
      }
    },
    [widgets],
  );

  const handleSaveWidgetConfig = useCallback((updatedWidget: WidgetConfig) => {
    setWidgets((prev) =>
      prev.map((w) => (w.id === updatedWidget.id ? updatedWidget : w)),
    );
    setEditingWidget(null);
    setConfigDialogOpen(false);
  }, []);

  const handleCloseConfigDialog = useCallback((open: boolean) => {
    setConfigDialogOpen(open);
    if (!open) {
      setEditingWidget(null);
    }
  }, []);

  const handleLayoutChange = useCallback((updatedWidgets: WidgetConfig[]) => {
    setWidgets(updatedWidgets);
  }, []);

  const handleUpdateWidgetSettings = useCallback(
    (widgetId: string, settings: Record<string, unknown>) => {
      setWidgets((prev) =>
        prev.map((w) => (w.id === widgetId ? { ...w, settings: settings } : w)),
      );
    },
    [],
  );

  // Save dashboard to Firebase
  const saveDashboard = useCallback(async () => {
    if (!session?.user?.id) {
      console.log("No user session found");
      toast({
        title: "Authentication required",
        description: "Please sign in to save your dashboard",
        variant: "destructive",
      });
      return;
    }

    console.log("Saving dashboard for user:", session.user.id);
    setLoading(true);
    try {
      await dashboardService.saveDashboard({
        id: currentDashboardId,
        name: "My Dashboard",
        description: "Custom dashboard configuration",
        widgets,
        isDefault: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      console.log("Dashboard saved successfully");
      toast({
        title: "Dashboard saved",
        description: "Your dashboard configuration has been saved successfully",
        variant: "default",
      });
    } catch (error) {
      console.error("Error saving dashboard:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to save dashboard";
      toast({
        title: "Error saving dashboard",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [session, currentDashboardId, widgets, toast]);

  // Load user's dashboard on mount
  useEffect(() => {
    const loadDashboard = async () => {
      if (!session?.user?.id) return;

      setLoading(true);
      try {
        const dashboards = await dashboardService.getUserDashboards();
        const defaultDashboard =
          dashboards.find((d) => d.isDefault) ?? dashboards[0];

        if (defaultDashboard) {
          setWidgets(defaultDashboard.widgets);
          setCurrentDashboardId(defaultDashboard.id);
        } else {
          // No existing dashboard, keep the generated ID for a new one
          console.log(
            "No existing dashboard found, will create new with ID:",
            currentDashboardId,
          );
        }
      } catch (error) {
        console.error("Error loading dashboards:", error);
        // Use default widgets if loading fails
      } finally {
        setLoading(false);
      }
    };

    void loadDashboard();
  }, [session]);

  // Note: This route is protected by middleware, so if we reach here, user is authenticated
  // Show loading spinner while session is being hydrated from server
  // Don't show LoginRequired since middleware already checked authentication
  if (status === "loading" || !session) {
    return (
      <DashboardLayout fullWidth>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout fullWidth>
      {loading && widgets.length === 0 && (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}
      {(!loading || widgets.length > 0) && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <div className="flex items-center gap-2">
              {isEditMode && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsEditMode(false)}
                >
                  Cancel
                </Button>
              )}
              <Button
                variant={isEditMode ? "default" : "outline"}
                size="sm"
                onClick={async () => {
                  if (isEditMode) {
                    // Exit edit mode first
                    setIsEditMode(false);

                    // Then save if authenticated
                    if (session?.user?.id) {
                      try {
                        await saveDashboard();
                      } catch (error) {
                        console.error("Failed to save dashboard:", error);
                        // Re-enable edit mode if save failed
                        setIsEditMode(true);
                      }
                    }
                  } else {
                    setIsEditMode(true);
                  }
                }}
                disabled={loading}
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : isEditMode ? (
                  <>
                    <Save className="mr-2 h-4 w-4" />
                    Save Layout
                  </>
                ) : (
                  <>
                    <Edit2 className="mr-2 h-4 w-4" />
                    Edit Dashboard
                  </>
                )}
              </Button>
              {isEditMode && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Plus className="mr-2 h-4 w-4" />
                      Add Widget
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    {Object.values(WidgetCategory).map((category) => (
                      <div key={category}>
                        <DropdownMenuLabel>{category}</DropdownMenuLabel>
                        {widgetRegistry
                          .getByCategory(category)
                          .map((definition) => {
                            const Icon = definition.icon;
                            return (
                              <DropdownMenuItem
                                key={definition.type}
                                onClick={() => handleAddWidget(definition.type)}
                              >
                                <Icon className="mr-2 h-4 w-4" />
                                {definition.type
                                  .replace(/_/g, " ")
                                  .toLowerCase()
                                  .replace(/\b\w/g, (l) => l.toUpperCase())}
                              </DropdownMenuItem>
                            );
                          })}
                        <DropdownMenuSeparator />
                      </div>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
          <DashboardGrid
            widgets={widgets}
            isEditMode={isEditMode}
            onLayoutChange={handleLayoutChange}
            onRemoveWidget={handleRemoveWidget}
            onEditWidget={handleEditWidget}
            onUpdateWidgetSettings={handleUpdateWidgetSettings}
          />
          <WidgetConfigDialog
            widget={editingWidget}
            open={configDialogOpen}
            onOpenChange={handleCloseConfigDialog}
            onSave={handleSaveWidgetConfig}
          />
        </div>
      )}
    </DashboardLayout>
  );
}
