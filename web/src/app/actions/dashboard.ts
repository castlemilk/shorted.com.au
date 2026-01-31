"use server";

import { auth } from "@/auth";
import { type DashboardConfig } from "~/@/types/dashboard";
import { initializeApp, cert, getApps, type App } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// Initialize Firebase Admin SDK
let app: App;

if (!getApps().length) {
  const projectId = process.env.AUTH_FIREBASE_PROJECT_ID?.trim();
  console.log("Initializing Firebase Admin with project:", projectId);
  
  app = initializeApp({
    credential: cert({
      projectId: projectId,
      clientEmail: process.env.AUTH_FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.AUTH_FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
    projectId: projectId, // Explicitly set the project ID
  });
} else {
  app = getApps()[0]!;
}

const adminDb = getFirestore(app);

const COLLECTION_NAME = "dashboards";

export async function saveDashboard(dashboard: DashboardConfig) {
  console.log("saveDashboard called with:", dashboard.id);
  
  try {
    const session = await auth();
    console.log("Session:", session);
    
    if (!session?.user?.id) {
      console.error("No user session found");
      return { success: false, error: "User must be authenticated to save dashboards" };
    }

    const userId = session.user.id;
    console.log("Saving dashboard for user:", userId, dashboard.id);

    const dashboardData = {
      name: dashboard.name,
      description: dashboard.description,
      widgets: dashboard.widgets,
      userId: userId,
      isDefault: dashboard.isDefault ?? false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const docRef = adminDb
      .collection(COLLECTION_NAME)
      .doc(dashboard.id);
      
    console.log("Writing to collection:", COLLECTION_NAME);
    console.log("Document ID:", dashboard.id);
    console.log("Dashboard data:", dashboardData);
    
    await docRef.set(dashboardData);

    // Verify the write
    const savedDoc = await docRef.get();
    console.log("Document exists after write:", savedDoc.exists);
    console.log("Dashboard saved successfully");
    
    return { success: true, id: dashboard.id };
  } catch (error) {
    console.error("Error saving dashboard:", error);
    console.error("Error details:", error instanceof Error ? error.message : error);
    
    // Check if this is a NextAuth redirect error
    if (error instanceof Error && error.message.includes("NEXT_REDIRECT")) {
      // Re-throw redirect errors so Next.js can handle them
      throw error;
    }
    
    return { 
      success: false, 
      error: error instanceof Error ? error.message : "Failed to save dashboard" 
    };
  }
}

export async function getUserDashboards() {
  const session = await auth();
  
  if (!session?.user?.id) {
    return [];
  }

  const userId = session.user.id;

  try {
    const dashboardsSnapshot = await adminDb
      .collection(COLLECTION_NAME)
      .where("userId", "==", userId)
      .get();

    const dashboards: DashboardConfig[] = [];
    
    dashboardsSnapshot.forEach((doc) => {
      const data = doc.data();
      if (data) {
        dashboards.push({
          id: doc.id,
          name: data.name as string,
          description: data.description as string,
          widgets: data.widgets as DashboardConfig['widgets'],
          isDefault: data.isDefault as boolean,
          createdAt: data.createdAt ? (data.createdAt as { toDate(): Date }).toDate() : new Date(),
          updatedAt: data.updatedAt ? (data.updatedAt as { toDate(): Date }).toDate() : new Date(),
        });
      }
    });

    return dashboards;
  } catch (error) {
    console.error("Error loading dashboards:", error);
    return [];
  }
}

export async function deleteDashboard(dashboardId: string) {
  try {
    const session = await auth();
    
    if (!session?.user?.id) {
      return { success: false, error: "User must be authenticated to delete dashboards" };
    }

    const userId = session.user.id;

    // Verify ownership
    const dashboardDoc = await adminDb
      .collection(COLLECTION_NAME)
      .doc(dashboardId)
      .get();

    if (!dashboardDoc.exists) {
      return { success: false, error: "Dashboard not found" };
    }

    const data = dashboardDoc.data();
    if (data?.userId !== userId) {
      return { success: false, error: "Unauthorized" };
    }

    await adminDb
      .collection(COLLECTION_NAME)
      .doc(dashboardId)
      .delete();

    return { success: true };
  } catch (error) {
    console.error("Error deleting dashboard:", error);
    
    // Check if this is a NextAuth redirect error
    if (error instanceof Error && error.message.includes("NEXT_REDIRECT")) {
      throw error;
    }
    
    return { 
      success: false, 
      error: error instanceof Error ? error.message : "Failed to delete dashboard" 
    };
  }
}

export async function setDefaultDashboard(dashboardId: string) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return { success: false, error: "User must be authenticated to update dashboards" };
    }

    const userId = session.user.id;

    // First, unset all other default dashboards for this user
    const dashboardsSnapshot = await adminDb
      .collection(COLLECTION_NAME)
      .where("userId", "==", userId)
      .where("isDefault", "==", true)
      .get();

    const batch = adminDb.batch();

    dashboardsSnapshot.forEach((doc) => {
      if (doc.id !== dashboardId) {
        batch.update(doc.ref, {
          isDefault: false,
          updatedAt: FieldValue.serverTimestamp()
        });
      }
    });

    // Set the new default
    const targetDashboard = adminDb
      .collection(COLLECTION_NAME)
      .doc(dashboardId);

    batch.update(targetDashboard, {
      isDefault: true,
      updatedAt: FieldValue.serverTimestamp()
    });

    await batch.commit();

    return { success: true };
  } catch (error) {
    console.error("Error setting default dashboard:", error);

    // Check if this is a NextAuth redirect error
    if (error instanceof Error && error.message.includes("NEXT_REDIRECT")) {
      throw error;
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to set default dashboard"
    };
  }
}

export async function renameDashboard(dashboardId: string, newName: string) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return { success: false, error: "User must be authenticated to rename dashboards" };
    }

    const userId = session.user.id;

    // Verify ownership
    const dashboardDoc = await adminDb
      .collection(COLLECTION_NAME)
      .doc(dashboardId)
      .get();

    if (!dashboardDoc.exists) {
      return { success: false, error: "Dashboard not found" };
    }

    const data = dashboardDoc.data();
    if (data?.userId !== userId) {
      return { success: false, error: "Unauthorized" };
    }

    await adminDb
      .collection(COLLECTION_NAME)
      .doc(dashboardId)
      .update({
        name: newName,
        updatedAt: FieldValue.serverTimestamp()
      });

    return { success: true };
  } catch (error) {
    console.error("Error renaming dashboard:", error);

    if (error instanceof Error && error.message.includes("NEXT_REDIRECT")) {
      throw error;
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to rename dashboard"
    };
  }
}

export async function duplicateDashboard(dashboardId: string, newName: string) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return { success: false, error: "User must be authenticated to duplicate dashboards" };
    }

    const userId = session.user.id;

    // Get the source dashboard
    const dashboardDoc = await adminDb
      .collection(COLLECTION_NAME)
      .doc(dashboardId)
      .get();

    if (!dashboardDoc.exists) {
      return { success: false, error: "Dashboard not found" };
    }

    const data = dashboardDoc.data();
    if (data?.userId !== userId) {
      return { success: false, error: "Unauthorized" };
    }

    // Create the duplicate
    const newDashboardRef = adminDb.collection(COLLECTION_NAME).doc();
    await newDashboardRef.set({
      name: newName,
      description: data?.description as string | undefined ?? "",
      widgets: data?.widgets as unknown[] ?? [],
      userId: userId,
      isDefault: false, // Duplicates are never default
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { success: true, id: newDashboardRef.id };
  } catch (error) {
    console.error("Error duplicating dashboard:", error);

    if (error instanceof Error && error.message.includes("NEXT_REDIRECT")) {
      throw error;
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to duplicate dashboard"
    };
  }
}

export async function exportDashboard(dashboardId: string) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return { success: false, error: "User must be authenticated to export dashboards" };
    }

    const userId = session.user.id;

    const dashboardDoc = await adminDb
      .collection(COLLECTION_NAME)
      .doc(dashboardId)
      .get();

    if (!dashboardDoc.exists) {
      return { success: false, error: "Dashboard not found" };
    }

    const data = dashboardDoc.data();
    if (data?.userId !== userId) {
      return { success: false, error: "Unauthorized" };
    }

    // Return the dashboard data without sensitive fields
    const exportData = {
      name: data?.name as string | undefined ?? "Dashboard",
      description: data?.description as string | undefined ?? "",
      widgets: data?.widgets as unknown[] ?? [],
      exportedAt: new Date().toISOString(),
      version: 1,
    };

    return { success: true, data: JSON.stringify(exportData, null, 2) };
  } catch (error) {
    console.error("Error exporting dashboard:", error);

    if (error instanceof Error && error.message.includes("NEXT_REDIRECT")) {
      throw error;
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to export dashboard"
    };
  }
}

export async function importDashboard(jsonString: string) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return { success: false, error: "User must be authenticated to import dashboards" };
    }

    const userId = session.user.id;

    // Parse and validate the import data
    let importData: { name?: string; description?: string; widgets?: unknown[]; version?: number };
    try {
      importData = JSON.parse(jsonString) as typeof importData;
    } catch {
      return { success: false, error: "Invalid JSON format" };
    }

    if (!importData.name || !Array.isArray(importData.widgets)) {
      return { success: false, error: "Invalid dashboard format: missing name or widgets" };
    }

    // Create the new dashboard
    const newDashboardRef = adminDb.collection(COLLECTION_NAME).doc();
    await newDashboardRef.set({
      name: importData.name,
      description: importData.description ?? "",
      widgets: importData.widgets,
      userId: userId,
      isDefault: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { success: true, id: newDashboardRef.id };
  } catch (error) {
    console.error("Error importing dashboard:", error);

    if (error instanceof Error && error.message.includes("NEXT_REDIRECT")) {
      throw error;
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to import dashboard"
    };
  }
}