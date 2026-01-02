import { type DashboardConfig } from "@/types/dashboard";
import {
  saveDashboard as saveDashboardAction,
  getUserDashboards as getUserDashboardsAction,
  deleteDashboard as deleteDashboardAction,
  setDefaultDashboard as setDefaultDashboardAction,
} from "@/app/actions/dashboard";

class DashboardService {
  async saveDashboard(dashboard: DashboardConfig): Promise<void> {
    const result = await saveDashboardAction(dashboard);
    if (!result.success) {
      throw new Error("Failed to save dashboard");
    }
  }

  async getDashboard(dashboardId: string): Promise<DashboardConfig | null> {
    // Get all dashboards and find the one with matching ID
    const dashboards = await this.getUserDashboards();
    return dashboards.find(d => d.id === dashboardId) ?? null;
  }

  async getUserDashboards(): Promise<DashboardConfig[]> {
    return await getUserDashboardsAction();
  }

  async deleteDashboard(dashboardId: string): Promise<void> {
    const result = await deleteDashboardAction(dashboardId);
    if (!result.success) {
      throw new Error("Failed to delete dashboard");
    }
  }

  async setDefaultDashboard(dashboardId: string): Promise<void> {
    const result = await setDefaultDashboardAction(dashboardId);
    if (!result.success) {
      throw new Error("Failed to set default dashboard");
    }
  }
}

export const dashboardService = new DashboardService();