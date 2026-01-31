"use client";

import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type DashboardConfig } from "@/types/dashboard";
import {
  ChevronDown,
  Plus,
  Star,
  Copy,
  Pencil,
  Trash2,
  Download,
  Upload,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface DashboardSwitcherProps {
  dashboards: DashboardConfig[];
  currentDashboardId: string;
  onSelect: (dashboardId: string) => void;
  onCreate: (name: string) => void;
  onRename: (dashboardId: string, newName: string) => void;
  onDuplicate: (dashboardId: string, newName: string) => void;
  onDelete: (dashboardId: string) => void;
  onSetDefault: (dashboardId: string) => void;
  onExport: (dashboardId: string) => void;
  onImport: (json: string) => void;
  className?: string;
}

export function DashboardSwitcher({
  dashboards,
  currentDashboardId,
  onSelect,
  onCreate,
  onRename,
  onDuplicate,
  onDelete,
  onSetDefault,
  onExport,
  onImport,
  className,
}: DashboardSwitcherProps) {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [isDuplicateOpen, setIsDuplicateOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [selectedDashboard, setSelectedDashboard] = useState<DashboardConfig | null>(
    null
  );
  const [inputValue, setInputValue] = useState("");
  const [importJson, setImportJson] = useState("");

  const currentDashboard = dashboards.find((d) => d.id === currentDashboardId);
  const _defaultDashboard = dashboards.find((d) => d.isDefault);

  const handleCreate = () => {
    if (inputValue.trim()) {
      onCreate(inputValue.trim());
      setInputValue("");
      setIsCreateOpen(false);
    }
  };

  const handleRename = () => {
    if (selectedDashboard && inputValue.trim()) {
      onRename(selectedDashboard.id, inputValue.trim());
      setInputValue("");
      setIsRenameOpen(false);
      setSelectedDashboard(null);
    }
  };

  const handleDuplicate = () => {
    if (selectedDashboard && inputValue.trim()) {
      onDuplicate(selectedDashboard.id, inputValue.trim());
      setInputValue("");
      setIsDuplicateOpen(false);
      setSelectedDashboard(null);
    }
  };

  const handleDelete = () => {
    if (selectedDashboard) {
      onDelete(selectedDashboard.id);
      setIsDeleteOpen(false);
      setSelectedDashboard(null);
    }
  };

  const handleImport = () => {
    if (importJson.trim()) {
      onImport(importJson.trim());
      setImportJson("");
      setIsImportOpen(false);
    }
  };

  const openRename = (dashboard: DashboardConfig) => {
    setSelectedDashboard(dashboard);
    setInputValue(dashboard.name);
    setIsRenameOpen(true);
  };

  const openDuplicate = (dashboard: DashboardConfig) => {
    setSelectedDashboard(dashboard);
    setInputValue(`${dashboard.name} (Copy)`);
    setIsDuplicateOpen(true);
  };

  const openDelete = (dashboard: DashboardConfig) => {
    setSelectedDashboard(dashboard);
    setIsDeleteOpen(true);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className={cn("gap-2", className)}>
            <span className="truncate max-w-[150px]">
              {currentDashboard?.name ?? "My Dashboard"}
            </span>
            {currentDashboard?.isDefault && (
              <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />
            )}
            <ChevronDown className="h-4 w-4 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>Dashboards</DropdownMenuLabel>
          <DropdownMenuSeparator />

          {dashboards.length === 0 ? (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">
              No dashboards yet
            </div>
          ) : (
            dashboards.map((dashboard) => (
              <DropdownMenuItem
                key={dashboard.id}
                className="flex items-center justify-between p-2 cursor-pointer"
                onSelect={(e) => {
                  e.preventDefault();
                  onSelect(dashboard.id);
                }}
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {dashboard.id === currentDashboardId && (
                    <Check className="h-4 w-4 shrink-0" />
                  )}
                  <span
                    className={cn(
                      "truncate",
                      dashboard.id !== currentDashboardId && "ml-6"
                    )}
                  >
                    {dashboard.name}
                  </span>
                  {dashboard.isDefault && (
                    <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation();
                      openRename(dashboard);
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation();
                      openDuplicate(dashboard);
                    }}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                  {!dashboard.isDefault && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSetDefault(dashboard.id);
                      }}
                    >
                      <Star className="h-3 w-3" />
                    </Button>
                  )}
                  {dashboards.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        openDelete(dashboard);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </DropdownMenuItem>
            ))
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={() => setIsCreateOpen(true)}
            className="cursor-pointer"
          >
            <Plus className="h-4 w-4 mr-2" />
            New Dashboard
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={() => currentDashboard && onExport(currentDashboard.id)}
            className="cursor-pointer"
            disabled={!currentDashboard}
          >
            <Download className="h-4 w-4 mr-2" />
            Export Current
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={() => setIsImportOpen(true)}
            className="cursor-pointer"
          >
            <Upload className="h-4 w-4 mr-2" />
            Import Dashboard
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Create Dialog */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Dashboard</DialogTitle>
            <DialogDescription>
              Enter a name for your new dashboard.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="My Dashboard"
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!inputValue.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={isRenameOpen} onOpenChange={setIsRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Dashboard</DialogTitle>
            <DialogDescription>Enter a new name for the dashboard.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="rename">Name</Label>
              <Input
                id="rename"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleRename()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRenameOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRename} disabled={!inputValue.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Duplicate Dialog */}
      <Dialog open={isDuplicateOpen} onOpenChange={setIsDuplicateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Duplicate Dashboard</DialogTitle>
            <DialogDescription>
              Enter a name for the duplicated dashboard.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="duplicate">Name</Label>
              <Input
                id="duplicate"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleDuplicate()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDuplicateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleDuplicate} disabled={!inputValue.trim()}>
              Duplicate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Alert Dialog */}
      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Dashboard</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{selectedDashboard?.name}
              &rdquo;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Import Dialog */}
      <Dialog open={isImportOpen} onOpenChange={setIsImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Dashboard</DialogTitle>
            <DialogDescription>
              Paste the exported dashboard JSON below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="import">Dashboard JSON</Label>
              <textarea
                id="import"
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder='{"name": "My Dashboard", "widgets": [...]}'
                className="w-full h-32 px-3 py-2 text-sm rounded-md border bg-background resize-none font-mono"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsImportOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleImport} disabled={!importJson.trim()}>
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
