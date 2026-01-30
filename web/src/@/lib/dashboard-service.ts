import { type DashboardConfig } from "@/types/dashboard";
import {
  saveDashboard as saveDashboardAction,
  getUserDashboards as getUserDashboardsAction,
  deleteDashboard as deleteDashboardAction,
  setDefaultDashboard as setDefaultDashboardAction,
  renameDashboard as renameDashboardAction,
  duplicateDashboard as duplicateDashboardAction,
  exportDashboard as exportDashboardAction,
  importDashboard as importDashboardAction,
} from "@/app/actions/dashboard";

class DashboardService {
  async saveDashboard(dashboard: DashboardConfig): Promise<void> {
    const result = await saveDashboardAction(dashboard);
    if (!result || !result.success) {
      const errorMessage = result?.error ?? "Failed to save dashboard";
      throw new Error(errorMessage);
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
    if (!result || !result.success) {
      const errorMessage = result?.error ?? "Failed to delete dashboard";
      throw new Error(errorMessage);
    }
  }

  async setDefaultDashboard(dashboardId: string): Promise<void> {
    const result = await setDefaultDashboardAction(dashboardId);
    if (!result || !result.success) {
      const errorMessage = result?.error ?? "Failed to set default dashboard";
      throw new Error(errorMessage);
    }
  }

  async renameDashboard(dashboardId: string, newName: string): Promise<void> {
    const result = await renameDashboardAction(dashboardId, newName);
    if (!result || !result.success) {
      const errorMessage = result?.error ?? "Failed to rename dashboard";
      throw new Error(errorMessage);
    }
  }

  async duplicateDashboard(dashboardId: string, newName: string): Promise<string> {
    const result = await duplicateDashboardAction(dashboardId, newName);
    if (!result || !result.success || !result.id) {
      const errorMessage = result?.error ?? "Failed to duplicate dashboard";
      throw new Error(errorMessage);
    }
    return result.id;
  }

  async exportDashboard(dashboardId: string): Promise<string> {
    const result = await exportDashboardAction(dashboardId);
    if (!result || !result.success || !result.data) {
      const errorMessage = result?.error ?? "Failed to export dashboard";
      throw new Error(errorMessage);
    }
    return result.data;
  }

  async importDashboard(jsonString: string): Promise<string> {
    const result = await importDashboardAction(jsonString);
    if (!result || !result.success || !result.id) {
      const errorMessage = result?.error ?? "Failed to import dashboard";
      throw new Error(errorMessage);
    }
    return result.id;
  }
}

export const dashboardService = new DashboardService();
