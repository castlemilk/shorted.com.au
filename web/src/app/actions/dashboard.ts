"use server";

import { auth } from "@/auth";
import { type DashboardConfig } from "@/types/dashboard";
import { initializeApp, cert, getApps, type App } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// Initialize Firebase Admin SDK
let app: App;

if (!getApps().length) {
  const projectId = process.env.AUTH_FIREBASE_PROJECT_ID;
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
  
  const session = await auth();
  console.log("Session:", session);
  
  if (!session?.user?.id) {
    console.error("No user session found");
    throw new Error("User must be authenticated to save dashboards");
  }

  const userId = session.user.id;
  console.log("Saving dashboard for user:", userId, dashboard.id);

  try {
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
    throw new Error("Failed to save dashboard");
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
  const session = await auth();
  
  if (!session?.user?.id) {
    throw new Error("User must be authenticated to delete dashboards");
  }

  const userId = session.user.id;

  try {
    // Verify ownership
    const dashboardDoc = await adminDb
      .collection(COLLECTION_NAME)
      .doc(dashboardId)
      .get();

    if (!dashboardDoc.exists) {
      throw new Error("Dashboard not found");
    }

    const data = dashboardDoc.data();
    if (data?.userId !== userId) {
      throw new Error("Unauthorized");
    }

    await adminDb
      .collection(COLLECTION_NAME)
      .doc(dashboardId)
      .delete();

    return { success: true };
  } catch (error) {
    console.error("Error deleting dashboard:", error);
    throw new Error("Failed to delete dashboard");
  }
}

export async function setDefaultDashboard(dashboardId: string) {
  const session = await auth();
  
  if (!session?.user?.id) {
    throw new Error("User must be authenticated to update dashboards");
  }

  const userId = session.user.id;

  try {
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
    throw new Error("Failed to set default dashboard");
  }
}