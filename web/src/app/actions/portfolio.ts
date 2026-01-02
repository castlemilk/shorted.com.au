"use server";

import { auth } from "@/auth";
import { initializeApp, cert, getApps, type App } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// Initialize Firebase Admin SDK
let app: App;

if (!getApps().length) {
  const projectId = process.env.AUTH_FIREBASE_PROJECT_ID;
  app = initializeApp({
    credential: cert({
      projectId: projectId,
      clientEmail: process.env.AUTH_FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.AUTH_FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
    projectId: projectId,
  });
} else {
  app = getApps()[0]!;
}

const adminDb = getFirestore(app);

// Types
export interface PortfolioHolding {
  symbol: string;
  shares: number;
  averagePrice: number;
  purchaseDate?: string;
  notes?: string;
}

export interface WatchlistItem {
  symbol: string;
  addedAt: Date;
  alerts?: {
    priceAbove?: number;
    priceBelow?: number;
  };
}

// Portfolio Management
export async function getPortfolio() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("User must be authenticated");
  }

  const userId = session.user.id;
  
  try {
    const doc = await adminDb
      .collection("portfolios")
      .doc(userId)
      .get();

    if (!doc.exists) {
      return { holdings: [] };
    }

    const data = doc.data();
    return {
      holdings: (data?.holdings as PortfolioHolding[]) ?? [],
      updatedAt: data?.updatedAt ? (data.updatedAt as { toDate(): Date }).toDate() : new Date(),
    };
  } catch (error) {
    console.error("Error fetching portfolio:", error);
    throw new Error("Failed to fetch portfolio");
  }
}

export async function savePortfolio(holdings: PortfolioHolding[]) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("User must be authenticated");
  }

  const userId = session.user.id;
  
  try {
    await adminDb
      .collection("portfolios")
      .doc(userId)
      .set({
        holdings,
        userId,
        updatedAt: FieldValue.serverTimestamp(),
      });

    return { success: true };
  } catch (error) {
    console.error("Error saving portfolio:", error);
    throw new Error("Failed to save portfolio");
  }
}

export async function addHolding(holding: PortfolioHolding) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("User must be authenticated");
  }

  const userId = session.user.id;
  
  try {
    const docRef = adminDb.collection("portfolios").doc(userId);
    const doc = await docRef.get();
    
    const currentHoldings = doc.exists ? ((doc.data()?.holdings as PortfolioHolding[]) ?? []) : [];
    
    // Check if stock already exists
    const existingIndex = currentHoldings.findIndex(
      (h: PortfolioHolding) => h.symbol === holding.symbol
    );
    
    if (existingIndex >= 0) {
      // Update existing holding (average the price)
      const existing = currentHoldings[existingIndex]!;
      const totalShares = existing.shares + holding.shares;
      const totalCost = (existing.shares * existing.averagePrice) + 
                       (holding.shares * holding.averagePrice);
      
      currentHoldings[existingIndex] = {
        ...existing,
        shares: totalShares,
        averagePrice: totalCost / totalShares,
      };
    } else {
      // Add new holding
      currentHoldings.push(holding);
    }
    
    await docRef.set({
      holdings: currentHoldings,
      userId,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { success: true };
  } catch (error) {
    console.error("Error adding holding:", error);
    throw new Error("Failed to add holding");
  }
}

export async function removeHolding(symbol: string) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("User must be authenticated");
  }

  const userId = session.user.id;
  
  try {
    const docRef = adminDb.collection("portfolios").doc(userId);
    const doc = await docRef.get();
    
    if (!doc.exists) {
      throw new Error("Portfolio not found");
    }
    
    const currentHoldings = (doc.data()?.holdings as PortfolioHolding[]) ?? [];
    const updatedHoldings = currentHoldings.filter(
      (h: PortfolioHolding) => h.symbol !== symbol
    );
    
    await docRef.set({
      holdings: updatedHoldings,
      userId,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { success: true };
  } catch (error) {
    console.error("Error removing holding:", error);
    throw new Error("Failed to remove holding");
  }
}

// Watchlist Management
export async function getWatchlist() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("User must be authenticated");
  }

  const userId = session.user.id;
  
  try {
    const doc = await adminDb
      .collection("watchlists")
      .doc(userId)
      .get();

    if (!doc.exists) {
      return { items: [] };
    }

    const data = doc.data();
    return {
      items: (data?.items as WatchlistItem[]) ?? [],
      updatedAt: data?.updatedAt ? (data.updatedAt as { toDate(): Date }).toDate() : new Date(),
    };
  } catch (error) {
    console.error("Error fetching watchlist:", error);
    throw new Error("Failed to fetch watchlist");
  }
}

export async function addToWatchlist(symbol: string) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("User must be authenticated");
  }

  const userId = session.user.id;
  
  try {
    const docRef = adminDb.collection("watchlists").doc(userId);
    const doc = await docRef.get();
    
    const currentItems = doc.exists ? ((doc.data()?.items as WatchlistItem[]) ?? []) : [];
    
    // Check if already in watchlist
    if (currentItems.some((item: WatchlistItem) => item.symbol === symbol)) {
      return { success: true, message: "Already in watchlist" };
    }
    
    currentItems.push({
      symbol,
      addedAt: new Date(),
    });
    
    await docRef.set({
      items: currentItems,
      userId,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { success: true };
  } catch (error) {
    console.error("Error adding to watchlist:", error);
    throw new Error("Failed to add to watchlist");
  }
}

export async function removeFromWatchlist(symbol: string) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("User must be authenticated");
  }

  const userId = session.user.id;
  
  try {
    const docRef = adminDb.collection("watchlists").doc(userId);
    const doc = await docRef.get();
    
    if (!doc.exists) {
      throw new Error("Watchlist not found");
    }
    
    const currentItems = (doc.data()?.items as WatchlistItem[]) ?? [];
    const updatedItems = currentItems.filter(
      (item: WatchlistItem) => item.symbol !== symbol
    );
    
    await docRef.set({
      items: updatedItems,
      userId,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { success: true };
  } catch (error) {
    console.error("Error removing from watchlist:", error);
    throw new Error("Failed to remove from watchlist");
  }
}