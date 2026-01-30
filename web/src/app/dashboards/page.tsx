"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { DashboardGrid } from "~/@/components/dashboard/dashboard-grid";
import { WidgetConfigDialog } from "~/@/components/dashboard/widget-config-dialog";
import { WidgetPicker } from "~/@/components/dashboard/widget-picker";
import { DashboardSwitcher } from "~/@/components/dashboard/dashboard-switcher";
import { SaveStatusIndicator } from "~/@/components/dashboard/save-status-indicator";
import { Button } from "~/@/components/ui/button";
import { Plus, Edit2, Save, Undo2, Redo2 } from "lucide-react";
import {
  type WidgetConfig,
  type DashboardConfig,
  WidgetType,
} from "~/@/types/dashboard";
import { widgetRegistry } from "~/@/lib/widget-registry";
import { v4 as uuidv4 } from "uuid";
import { dashboardService } from "~/@/lib/dashboard-service";
import { useToast } from "~/@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { useAutoSave } from "~/@/hooks/use-auto-save";
import { useUndoRedo } from "~/@/hooks/use-undo-redo";
import { useBreakpoint } from "~/@/hooks/use-breakpoint";
import { getTypedSettings } from "~/@/lib/widget-settings";

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
    layout: { x: 0, y: 0, w: 5, h: 14, minW: 4, minH: 6 },
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
    layout: { x: 5, y: 0, w: 7, h: 14, minW: 4, minH: 6 },
    settings: {
      period: "3m",
      viewMode: "CURRENT_CHANGE",
      showSectorGrouping: true,
    },
  },
];

const createDefaultDashboard = (): DashboardConfig => ({
  id: `dashboard-${uuidv4()}`,
  name: "My Dashboard",
  description: "Custom dashboard configuration",
  widgets: defaultWidgets,
  isDefault: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

export default function Dashboards() {
  const { data: session, status } = useSession();
  const { toast } = useToast();
  useBreakpoint(); // Available for responsive behavior

  // Dashboard list state
  const [dashboards, setDashboards] = useState<DashboardConfig[]>([]);
  const [currentDashboardId, setCurrentDashboardId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Edit mode state
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingWidget, setEditingWidget] = useState<WidgetConfig | null>(null);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [widgetPickerOpen, setWidgetPickerOpen] = useState(false);

  // Track last saved state to prevent save loops
  const lastSavedWidgetsRef = useRef<string>("");
  // Track which dashboard we've synced to prevent re-syncing on save
  const lastSyncedDashboardIdRef = useRef<string | null>(null);
  // Ref to access dashboards without adding to effect dependencies
  const dashboardsRef = useRef<DashboardConfig[]>([]);

  // Keep dashboardsRef in sync with dashboards state
  dashboardsRef.current = dashboards;

  // Get current dashboard
  const currentDashboard = dashboards.find((d) => d.id === currentDashboardId);

  // Undo/redo for widget changes
  const {
    state: widgets,
    setState: setWidgets,
    undo,
    redo,
    canUndo,
    canRedo,
    reset: resetWidgets,
  } = useUndoRedo({
    initialState: currentDashboard?.widgets ?? defaultWidgets,
    maxHistory: 50,
    debounceMs: 500,
  });

  // Memoized save callbacks to prevent useAutoSave from recreating markPending
  const handleSave = useCallback(async (dashboard: DashboardConfig) => {
    await dashboardService.saveDashboard(dashboard);
  }, []);

  const handleSaveSuccess = useCallback(() => {
    // Note: We intentionally don't update dashboards state here to avoid
    // triggering re-renders that could cause save loops
  }, []);

  const handleSaveError = useCallback((error: Error) => {
    toast({
      title: "Save failed",
      description: error.message,
      variant: "destructive",
    });
  }, [toast]);

  // Auto-save functionality
  const {
    status: saveStatus,
    lastSavedAt,
    error: saveError,
    markPending,
    saveNow,
    isOnline,
  } = useAutoSave({
    debounceMs: 1500,
    onSave: handleSave,
    onSaveSuccess: handleSaveSuccess,
    onSaveError: handleSaveError,
  });

  // Sync widgets with current dashboard when dashboard ID changes
  useEffect(() => {
    // Only sync when switching to a different dashboard
    if (currentDashboardId && currentDashboardId !== lastSyncedDashboardIdRef.current) {
      const dashboard = dashboards.find((d) => d.id === currentDashboardId);
      if (dashboard) {
        lastSyncedDashboardIdRef.current = currentDashboardId;
        resetWidgets(dashboard.widgets);
        lastSavedWidgetsRef.current = JSON.stringify(dashboard.widgets);
      }
    }
  }, [currentDashboardId, dashboards, resetWidgets]);

  // Auto-save when widgets change (with deduplication to prevent loops)
  useEffect(() => {
    if (!currentDashboardId || !session?.user?.id) return;

    // Serialize current widgets for comparison
    const currentWidgetsJson = JSON.stringify(widgets);

    // Skip if widgets haven't changed from last save
    if (currentWidgetsJson === lastSavedWidgetsRef.current) {
      return;
    }

    // Find the current dashboard from dashboards ref (avoids dependency on dashboards state)
    const dashboard = dashboardsRef.current.find((d) => d.id === currentDashboardId);
    if (!dashboard) return;

    // Update the ref and trigger save
    lastSavedWidgetsRef.current = currentWidgetsJson;
    markPending({
      ...dashboard,
      widgets,
      updatedAt: new Date(),
    });
  }, [widgets, currentDashboardId, session?.user?.id, markPending]);

  // Load dashboards on mount
  useEffect(() => {
    const loadDashboards = async () => {
      if (!session?.user?.id) return;

      setLoading(true);
      try {
        const userDashboards = await dashboardService.getUserDashboards();

        if (userDashboards.length > 0) {
          setDashboards(userDashboards);
          const defaultDashboard =
            userDashboards.find((d) => d.isDefault) ?? userDashboards[0];
          if (defaultDashboard) {
            setCurrentDashboardId(defaultDashboard.id);
            lastSyncedDashboardIdRef.current = defaultDashboard.id;
            resetWidgets(defaultDashboard.widgets);
            lastSavedWidgetsRef.current = JSON.stringify(defaultDashboard.widgets);
          }
        } else {
          // Create a new default dashboard
          const newDashboard = createDefaultDashboard();
          setDashboards([newDashboard]);
          setCurrentDashboardId(newDashboard.id);
          lastSyncedDashboardIdRef.current = newDashboard.id;
          resetWidgets(newDashboard.widgets);
          lastSavedWidgetsRef.current = JSON.stringify(newDashboard.widgets);
        }
      } catch (error) {
        console.error("Error loading dashboards:", error);
        // Use default widgets if loading fails
        const newDashboard = createDefaultDashboard();
        setDashboards([newDashboard]);
        setCurrentDashboardId(newDashboard.id);
        lastSyncedDashboardIdRef.current = newDashboard.id;
        resetWidgets(newDashboard.widgets);
        lastSavedWidgetsRef.current = JSON.stringify(newDashboard.widgets);
      } finally {
        setLoading(false);
      }
    };

    void loadDashboards();
  }, [session?.user?.id]);

  // Widget handlers
  const handleAddWidget = useCallback((type: WidgetType) => {
    const definition = widgetRegistry.getDefinition(type);
    if (!definition) return;

    const defaultSettings = getTypedSettings(type, {});

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
      settings: defaultSettings as unknown as Record<string, unknown>,
    };

    setWidgets((prev) => [...prev, newWidget]);
    setIsEditMode(true); // Auto-enter edit mode when adding widget
  }, [setWidgets]);

  const handleRemoveWidget = useCallback((widgetId: string) => {
    setWidgets((prev) => prev.filter((w) => w.id !== widgetId));
  }, [setWidgets]);

  const handleEditWidget = useCallback(
    (widgetId: string) => {
      const widget = widgets.find((w) => w.id === widgetId);
      if (widget) {
        setEditingWidget(widget);
        setConfigDialogOpen(true);
      }
    },
    [widgets]
  );

  const handleSaveWidgetConfig = useCallback((updatedWidget: WidgetConfig) => {
    setWidgets((prev) =>
      prev.map((w) => (w.id === updatedWidget.id ? updatedWidget : w))
    );
    setEditingWidget(null);
    setConfigDialogOpen(false);
  }, [setWidgets]);

  const handleCloseConfigDialog = useCallback((open: boolean) => {
    setConfigDialogOpen(open);
    if (!open) {
      setEditingWidget(null);
    }
  }, []);

  const handleLayoutChange = useCallback((updatedWidgets: WidgetConfig[]) => {
    setWidgets(updatedWidgets);
  }, [setWidgets]);

  const handleUpdateWidgetSettings = useCallback(
    (widgetId: string, settings: Record<string, unknown>) => {
      setWidgets((prev) =>
        prev.map((w) => (w.id === widgetId ? { ...w, settings } : w))
      );
    },
    [setWidgets]
  );

  // Dashboard management handlers
  const handleSelectDashboard = useCallback((dashboardId: string) => {
    setCurrentDashboardId(dashboardId);
  }, []);

  const handleCreateDashboard = useCallback(async (name: string) => {
    const newDashboard: DashboardConfig = {
      id: `dashboard-${uuidv4()}`,
      name,
      description: "",
      widgets: [],
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      await dashboardService.saveDashboard(newDashboard);
      setDashboards((prev) => [...prev, newDashboard]);
      setCurrentDashboardId(newDashboard.id);
      resetWidgets([]);
      toast({ title: "Dashboard created" });
    } catch (error) {
      toast({
        title: "Failed to create dashboard",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  }, [toast, resetWidgets]);

  const handleRenameDashboard = useCallback(async (dashboardId: string, newName: string) => {
    try {
      await dashboardService.renameDashboard(dashboardId, newName);
      setDashboards((prev) =>
        prev.map((d) => (d.id === dashboardId ? { ...d, name: newName } : d))
      );
      toast({ title: "Dashboard renamed" });
    } catch (error) {
      toast({
        title: "Failed to rename dashboard",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  }, [toast]);

  const handleDuplicateDashboard = useCallback(async (dashboardId: string, newName: string) => {
    try {
      const newId = await dashboardService.duplicateDashboard(dashboardId, newName);
      const sourceDashboard = dashboards.find((d) => d.id === dashboardId);
      if (sourceDashboard) {
        const newDashboard: DashboardConfig = {
          ...sourceDashboard,
          id: newId,
          name: newName,
          isDefault: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        setDashboards((prev) => [...prev, newDashboard]);
        setCurrentDashboardId(newId);
        toast({ title: "Dashboard duplicated" });
      }
    } catch (error) {
      toast({
        title: "Failed to duplicate dashboard",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  }, [dashboards, toast]);

  const handleDeleteDashboard = useCallback(async (dashboardId: string) => {
    try {
      await dashboardService.deleteDashboard(dashboardId);
      setDashboards((prev) => prev.filter((d) => d.id !== dashboardId));

      // Switch to another dashboard if we deleted the current one
      if (currentDashboardId === dashboardId) {
        const remaining = dashboards.filter((d) => d.id !== dashboardId);
        if (remaining.length > 0) {
          const nextDashboard = remaining.find((d) => d.isDefault) ?? remaining[0];
          if (nextDashboard) {
            setCurrentDashboardId(nextDashboard.id);
            resetWidgets(nextDashboard.widgets);
          }
        }
      }
      toast({ title: "Dashboard deleted" });
    } catch (error) {
      toast({
        title: "Failed to delete dashboard",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  }, [currentDashboardId, dashboards, toast, resetWidgets]);

  const handleSetDefaultDashboard = useCallback(async (dashboardId: string) => {
    try {
      await dashboardService.setDefaultDashboard(dashboardId);
      setDashboards((prev) =>
        prev.map((d) => ({
          ...d,
          isDefault: d.id === dashboardId,
        }))
      );
      toast({ title: "Default dashboard updated" });
    } catch (error) {
      toast({
        title: "Failed to set default dashboard",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  }, [toast]);

  const handleExportDashboard = useCallback(async (dashboardId: string) => {
    try {
      const json = await dashboardService.exportDashboard(dashboardId);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `dashboard-${dashboardId}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Dashboard exported" });
    } catch (error) {
      toast({
        title: "Failed to export dashboard",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  }, [toast]);

  const handleImportDashboard = useCallback(async (json: string) => {
    try {
      const newId = await dashboardService.importDashboard(json);
      const imported = JSON.parse(json) as { name: string; widgets: WidgetConfig[] };
      const newDashboard: DashboardConfig = {
        id: newId,
        name: imported.name ?? "Imported Dashboard",
        widgets: imported.widgets ?? [],
        isDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      setDashboards((prev) => [...prev, newDashboard]);
      setCurrentDashboardId(newId);
      resetWidgets(newDashboard.widgets);
      toast({ title: "Dashboard imported" });
    } catch (error) {
      toast({
        title: "Failed to import dashboard",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  }, [toast, resetWidgets]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      // 'e' to toggle edit mode
      if (e.key === "e" && !e.metaKey && !e.ctrlKey) {
        setIsEditMode((prev) => !prev);
      }

      // 'a' to add widget (in edit mode)
      if (e.key === "a" && !e.metaKey && !e.ctrlKey && isEditMode) {
        setWidgetPickerOpen(true);
      }

      // Cmd/Ctrl + S to save
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (currentDashboard) {
          void saveNow({
            ...currentDashboard,
            widgets,
            updatedAt: new Date(),
          });
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isEditMode, currentDashboard, widgets, saveNow]);

  // Loading state
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
          {/* Header */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <DashboardSwitcher
                dashboards={dashboards}
                currentDashboardId={currentDashboardId ?? ""}
                onSelect={handleSelectDashboard}
                onCreate={handleCreateDashboard}
                onRename={handleRenameDashboard}
                onDuplicate={handleDuplicateDashboard}
                onDelete={handleDeleteDashboard}
                onSetDefault={handleSetDefaultDashboard}
                onExport={handleExportDashboard}
                onImport={handleImportDashboard}
              />
              <SaveStatusIndicator
                status={saveStatus}
                lastSavedAt={lastSavedAt}
                error={saveError}
                isOnline={isOnline}
                onRetry={() => {
                  if (currentDashboard) {
                    void saveNow({
                      ...currentDashboard,
                      widgets,
                      updatedAt: new Date(),
                    });
                  }
                }}
              />
            </div>

            <div className="flex items-center gap-2">
              {/* Undo/Redo buttons (only in edit mode) */}
              {isEditMode && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={undo}
                    disabled={!canUndo}
                    title="Undo (Cmd+Z)"
                  >
                    <Undo2 className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={redo}
                    disabled={!canRedo}
                    title="Redo (Cmd+Shift+Z)"
                  >
                    <Redo2 className="h-4 w-4" />
                  </Button>
                </>
              )}

              {/* Edit/Save button */}
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
                onClick={() => {
                  if (isEditMode) {
                    setIsEditMode(false);
                    // Force save on exit
                    if (currentDashboard) {
                      void saveNow({
                        ...currentDashboard,
                        widgets,
                        updatedAt: new Date(),
                      });
                    }
                  } else {
                    setIsEditMode(true);
                  }
                }}
              >
                {isEditMode ? (
                  <>
                    <Save className="mr-2 h-4 w-4" />
                    Save Layout
                  </>
                ) : (
                  <>
                    <Edit2 className="mr-2 h-4 w-4" />
                    Edit
                  </>
                )}
              </Button>

              {/* Add Widget button */}
              {isEditMode && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setWidgetPickerOpen(true)}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add Widget
                </Button>
              )}
            </div>
          </div>

          {/* Dashboard Grid */}
          <DashboardGrid
            widgets={widgets}
            isEditMode={isEditMode}
            onLayoutChange={handleLayoutChange}
            onRemoveWidget={handleRemoveWidget}
            onEditWidget={handleEditWidget}
            onUpdateWidgetSettings={handleUpdateWidgetSettings}
          />

          {/* Widget Config Dialog */}
          <WidgetConfigDialog
            widget={editingWidget}
            open={configDialogOpen}
            onOpenChange={handleCloseConfigDialog}
            onSave={handleSaveWidgetConfig}
          />

          {/* Widget Picker */}
          <WidgetPicker
            open={widgetPickerOpen}
            onOpenChange={setWidgetPickerOpen}
            onAddWidget={handleAddWidget}
          />
        </div>
      )}
    </DashboardLayout>
  );
}
