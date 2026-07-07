import {
  getUserDashboards,
  saveDashboard,
  setDefaultDashboard,
} from "../dashboard";
import { auth } from "@/auth";
import { adminDb } from "@/lib/firebase-admin";
import { WidgetType, type DashboardConfig } from "~/@/types/dashboard";

jest.mock("@/lib/firebase-admin", () => ({
  adminDb: {
    batch: jest.fn(),
    collection: jest.fn(),
  },
}));

jest.mock("@/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: jest.fn(() => "server-timestamp"),
  },
}));

describe("dashboard cost controls", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("saves a dashboard without verifying the write with an immediate read", async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    const get = jest.fn().mockResolvedValue({ exists: true });
    const doc = jest.fn(() => ({ set, get }));
    (adminDb.collection as jest.Mock).mockReturnValue({ doc });
    (auth as jest.Mock).mockResolvedValue({ user: { id: "user-123" } });

    const dashboard: DashboardConfig = {
      id: "dashboard-1",
      name: "Main board",
      description: "Daily view",
      isDefault: true,
      createdAt: new Date("2026-07-04T00:00:00Z"),
      updatedAt: new Date("2026-07-04T00:00:00Z"),
      widgets: [
        {
          id: "widget-1",
          type: WidgetType.TOP_SHORTS,
          title: "Top shorts",
          dataSource: { endpoint: "/api/shorts/top" },
          layout: { x: 0, y: 0, w: 4, h: 4 },
        },
      ],
    };

    const result = await saveDashboard(dashboard);

    expect(result).toEqual({ success: true, id: "dashboard-1" });
    expect(set).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it("bounds dashboard list reads", async () => {
    const get = jest.fn().mockResolvedValue({
      forEach: jest.fn(),
    });
    const limit = jest.fn(() => ({ get }));
    const where = jest.fn(() => ({ limit }));
    (adminDb.collection as jest.Mock).mockReturnValue({ where });
    (auth as jest.Mock).mockResolvedValue({ user: { id: "user-123" } });

    await getUserDashboards();

    expect(where).toHaveBeenCalledWith("userId", "==", "user-123");
    expect(limit).toHaveBeenCalledWith(50);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("bounds default-dashboard scans before batch updates", async () => {
    const get = jest.fn().mockResolvedValue({
      forEach: jest.fn(),
    });
    const limit = jest.fn(() => ({ get }));
    const whereDefault = jest.fn(() => ({ limit }));
    const whereUser = jest.fn(() => ({ where: whereDefault }));
    const doc = jest.fn(() => ({ id: "dashboard-1" }));
    const update = jest.fn();
    const commit = jest.fn().mockResolvedValue(undefined);
    (adminDb.collection as jest.Mock).mockReturnValue({
      doc,
      where: whereUser,
    });
    (adminDb.batch as jest.Mock).mockReturnValue({ commit, update });
    (auth as jest.Mock).mockResolvedValue({ user: { id: "user-123" } });

    const result = await setDefaultDashboard("dashboard-1");

    expect(result).toEqual({ success: true });
    expect(whereUser).toHaveBeenCalledWith("userId", "==", "user-123");
    expect(whereDefault).toHaveBeenCalledWith("isDefault", "==", true);
    expect(limit).toHaveBeenCalledWith(20);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
