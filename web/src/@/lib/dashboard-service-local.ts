import { type DashboardConfig } from "@/types/dashboard";

export interface LocalDashboard extends Omit<DashboardConfig, 'createdAt' | 'updatedAt'> {
  createdAt: string;
  updatedAt: string;
}

class LocalDashboardService {
  private readonly STORAGE_KEY = "dashboards";
  private readonly DEFAULT_DASHBOARD_KEY = "default-dashboard";

  private ensureLocalStorage(): boolean {
    return typeof window !== "undefined" && typeof localStorage !== "undefined";
  }

  private getDashboards(): LocalDashboard[] {
    if (!this.ensureLocalStorage()) return [];
    
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      return stored ? JSON.parse(stored) as LocalDashboard[] : [];
    } catch (error) {
      console.error("Error reading dashboards from localStorage:", error);
      return [];
    }
  }

  private saveDashboards(dashboards: LocalDashboard[]): void {
    if (!this.ensureLocalStorage()) return;
    
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(dashboards));
    } catch (error) {
      console.error("Error saving dashboards to localStorage:", error);
      throw new Error("Failed to save dashboard to local storage");
    }
  }

  async saveDashboard(dashboard: DashboardConfig, _userId?: string): Promise<void> {
    if (!this.ensureLocalStorage()) {
      throw new Error("Local storage is not available");
    }

    const dashboards = this.getDashboards();
    const now = new Date().toISOString();
    
    // Convert dates to strings for localStorage
    const localDashboard: LocalDashboard = {
      ...dashboard,
      createdAt: dashboard.createdAt?.toISOString() || now,
      updatedAt: now,
    };

    // Find existing dashboard by ID
    const existingIndex = dashboards.findIndex(d => d.id === dashboard.id);
    
    if (existingIndex >= 0) {
      // Update existing dashboard, preserve creation date
      dashboards[existingIndex] = {
        ...localDashboard,
        createdAt: dashboards[existingIndex]?.createdAt ?? new Date().toISOString()
      };
    } else {
      // Add new dashboard
      dashboards.push(localDashboard);
    }

    this.saveDashboards(dashboards);
  }

  async getDashboard(dashboardId: string, _userId?: string): Promise<DashboardConfig | null> {
    if (!this.ensureLocalStorage()) return null;

    const dashboards = this.getDashboards();
    const dashboard = dashboards.find(d => d.id === dashboardId);
    
    if (!dashboard) return null;

    // Convert string dates back to Date objects
    return {
      ...dashboard,
      createdAt: new Date(dashboard.createdAt),
      updatedAt: new Date(dashboard.updatedAt),
    };
  }

  async getUserDashboards(_userId?: string): Promise<DashboardConfig[]> {
    if (!this.ensureLocalStorage()) return [];

    const dashboards = this.getDashboards();
    
    // Convert all dashboards back to proper format
    return dashboards.map(dashboard => ({
      ...dashboard,
      createdAt: new Date(dashboard.createdAt),
      updatedAt: new Date(dashboard.updatedAt),
    }));
  }

  async deleteDashboard(dashboardId: string, _userId?: string): Promise<void> {
    if (!this.ensureLocalStorage()) return;

    const dashboards = this.getDashboards();
    const filteredDashboards = dashboards.filter(d => d.id !== dashboardId);
    this.saveDashboards(filteredDashboards);
  }

  async setDefaultDashboard(dashboardId: string, _userId?: string): Promise<void> {
    if (!this.ensureLocalStorage()) return;

    const dashboards = this.getDashboards();
    
    // Update all dashboards to set/unset default
    const updatedDashboards = dashboards.map(dashboard => ({
      ...dashboard,
      isDefault: dashboard.id === dashboardId,
      updatedAt: new Date().toISOString()
    }));

    this.saveDashboards(updatedDashboards);
  }

  // Utility method to export dashboard data (for backup/sync)
  async exportDashboards(): Promise<LocalDashboard[]> {
    return this.getDashboards();
  }

  // Utility method to import dashboard data (for backup/sync)
  async importDashboards(dashboards: LocalDashboard[]): Promise<void> {
    if (!this.ensureLocalStorage()) return;
    this.saveDashboards(dashboards);
  }

  // Clear all dashboards
  async clearAll(): Promise<void> {
    if (!this.ensureLocalStorage()) return;
    
    try {
      localStorage.removeItem(this.STORAGE_KEY);
      localStorage.removeItem(this.DEFAULT_DASHBOARD_KEY);
    } catch (error) {
      console.error("Error clearing dashboards from localStorage:", error);
    }
  }
}

export const localDashboardService = new LocalDashboardService();