"use client";

import { useSession } from "next-auth/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { dashboardService } from "@/lib/dashboard-service";
import { type DashboardConfig } from "@/types/dashboard";

export default function TestDashboard() {
  const { data: session } = useSession();
  const [loading, setLoading] = useState(false);
  const [dashboards, setDashboards] = useState<DashboardConfig[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const testSaveDashboard = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const testDashboard: DashboardConfig = {
        id: `test-dashboard-${Date.now()}`,
        name: "Test Dashboard",
        description: "Testing dashboard save functionality",
        widgets: [],
        isDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await dashboardService.saveDashboard(testDashboard);
      setSuccess("Dashboard saved successfully!");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save dashboard");
    } finally {
      setLoading(false);
    }
  };

  const testLoadDashboards = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const loadedDashboards = await dashboardService.getUserDashboards();
      setDashboards(loadedDashboards);
      setSuccess(`Loaded ${loadedDashboards.length} dashboards`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboards");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto p-8">
      <h1 className="text-2xl font-bold mb-6">Dashboard API Test</h1>
      
      <div className="mb-4">
        <p>Session Status: {session ? `Logged in as ${session.user?.email}` : "Not logged in"}</p>
        <p>User ID: {session?.user?.id ?? "N/A"}</p>
      </div>

      <div className="space-y-4">
        <Button onClick={testSaveDashboard} disabled={loading || !session}>
          {loading ? "Saving..." : "Test Save Dashboard"}
        </Button>

        <Button onClick={testLoadDashboards} disabled={loading || !session}>
          {loading ? "Loading..." : "Test Load Dashboards"}
        </Button>
      </div>

      {error && (
        <div className="mt-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
          Error: {error}
        </div>
      )}

      {success && (
        <div className="mt-4 p-4 bg-green-100 border border-green-400 text-green-700 rounded">
          Success: {success}
        </div>
      )}

      {dashboards.length > 0 && (
        <div className="mt-6">
          <h2 className="text-xl font-semibold mb-3">Loaded Dashboards:</h2>
          <ul className="space-y-2">
            {dashboards.map((dashboard) => (
              <li key={dashboard.id} className="p-3 bg-gray-100 rounded">
                <p className="font-medium">{dashboard.name}</p>
                <p className="text-sm text-gray-600">{dashboard.description}</p>
                <p className="text-xs text-gray-500">ID: {dashboard.id}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}