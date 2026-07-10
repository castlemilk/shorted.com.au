"use server";

import { auth } from "@/auth";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin-db";
import { withFirestoreCost } from "@/lib/firestore-cost";
import {
  rememberLegacyEmailLookupMiss,
  shouldTryLegacyEmailLookup,
} from "@/lib/firestore-legacy-email-lookup-cache";

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

function trackPortfolioRead<T>(operation: () => Promise<T>) {
  return withFirestoreCost(
    {
      feature: "portfolio",
      collection: "portfolios",
      operation: "doc_get",
      documentsRead: 1,
    },
    operation,
  );
}

function trackPortfolioWrite<T>(operation: () => Promise<T>) {
  return withFirestoreCost(
    {
      feature: "portfolio",
      collection: "portfolios",
      operation: "set",
      documentsWritten: 1,
    },
    operation,
  );
}

function trackWatchlistRead<T>(operation: () => Promise<T>) {
  return withFirestoreCost(
    {
      feature: "watchlist",
      collection: "watchlists",
      operation: "doc_get",
      documentsRead: 1,
    },
    operation,
  );
}

function trackWatchlistWrite<T>(operation: () => Promise<T>) {
  return withFirestoreCost(
    {
      feature: "watchlist",
      collection: "watchlists",
      operation: "set",
      documentsWritten: 1,
    },
    operation,
  );
}

// Portfolio Management
export async function getPortfolio() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("User must be authenticated");
  }

  const userId = session.user.id;
  const userEmail = session.user.email;
  
  try {
    // First try with current user ID
    const doc = await trackPortfolioRead(() => adminDb
      .collection("portfolios")
      .doc(userId)
      .get());

    // If not found and we have an email, try looking up by email as fallback
    // This handles cases where data was stored under email instead of OAuth ID
    const legacyUserEmail = userEmail ?? "";
    if (shouldTryLegacyEmailLookup("portfolios", userId, legacyUserEmail)) {
      const emailDoc = await trackPortfolioRead(() => adminDb
        .collection("portfolios")
        .doc(legacyUserEmail)
        .get());
      
      if (emailDoc.exists) {
        // Migrate the data to the correct userId
        const portfolioData = emailDoc.data();
        await trackPortfolioWrite(() => adminDb
          .collection("portfolios")
          .doc(userId)
          .set({
            ...portfolioData,
            userId: userId,
            migratedFrom: legacyUserEmail,
            migratedAt: FieldValue.serverTimestamp(),
          }));
        
        return {
          holdings: (portfolioData?.holdings as PortfolioHolding[]) ?? [],
          updatedAt: portfolioData?.updatedAt ? (portfolioData.updatedAt as { toDate(): Date }).toDate() : new Date(),
        };
      }

      rememberLegacyEmailLookupMiss("portfolios", userId, legacyUserEmail);
    }

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
    await trackPortfolioWrite(() => adminDb
      .collection("portfolios")
      .doc(userId)
      .set({
        holdings,
        userId,
        updatedAt: FieldValue.serverTimestamp(),
      }));

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
    const doc = await trackPortfolioRead(() => docRef.get());
    
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
    
    await trackPortfolioWrite(() => docRef.set({
      holdings: currentHoldings,
      userId,
      updatedAt: FieldValue.serverTimestamp(),
    }));

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
    const doc = await trackPortfolioRead(() => docRef.get());
    
    if (!doc.exists) {
      throw new Error("Portfolio not found");
    }
    
    const currentHoldings = (doc.data()?.holdings as PortfolioHolding[]) ?? [];
    const updatedHoldings = currentHoldings.filter(
      (h: PortfolioHolding) => h.symbol !== symbol
    );
    
    await trackPortfolioWrite(() => docRef.set({
      holdings: updatedHoldings,
      userId,
      updatedAt: FieldValue.serverTimestamp(),
    }));

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
  const userEmail = session.user.email;
  
  try {
    // First try with current user ID
    const doc = await trackWatchlistRead(() => adminDb
      .collection("watchlists")
      .doc(userId)
      .get());

    // If not found and we have an email, try looking up by email as fallback
    const legacyUserEmail = userEmail ?? "";
    if (shouldTryLegacyEmailLookup("watchlists", userId, legacyUserEmail)) {
      const emailDoc = await trackWatchlistRead(() => adminDb
        .collection("watchlists")
        .doc(legacyUserEmail)
        .get());
      
      if (emailDoc.exists) {
        // Migrate the data to the correct userId
        const watchlistData = emailDoc.data();
        await trackWatchlistWrite(() => adminDb
          .collection("watchlists")
          .doc(userId)
          .set({
            ...watchlistData,
            userId: userId,
            migratedFrom: legacyUserEmail,
            migratedAt: FieldValue.serverTimestamp(),
          }));
        
        return {
          items: (watchlistData?.items as WatchlistItem[]) ?? [],
          updatedAt: watchlistData?.updatedAt ? (watchlistData.updatedAt as { toDate(): Date }).toDate() : new Date(),
        };
      }

      rememberLegacyEmailLookupMiss("watchlists", userId, legacyUserEmail);
    }

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
    const doc = await trackWatchlistRead(() => docRef.get());
    
    const currentItems = doc.exists ? ((doc.data()?.items as WatchlistItem[]) ?? []) : [];
    
    // Check if already in watchlist
    if (currentItems.some((item: WatchlistItem) => item.symbol === symbol)) {
      return { success: true, message: "Already in watchlist" };
    }
    
    currentItems.push({
      symbol,
      addedAt: new Date(),
    });
    
    await trackWatchlistWrite(() => docRef.set({
      items: currentItems,
      userId,
      updatedAt: FieldValue.serverTimestamp(),
    }));

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
    const doc = await trackWatchlistRead(() => docRef.get());
    
    if (!doc.exists) {
      throw new Error("Watchlist not found");
    }
    
    const currentItems = (doc.data()?.items as WatchlistItem[]) ?? [];
    const updatedItems = currentItems.filter(
      (item: WatchlistItem) => item.symbol !== symbol
    );
    
    await trackWatchlistWrite(() => docRef.set({
      items: updatedItems,
      userId,
      updatedAt: FieldValue.serverTimestamp(),
    }));

    return { success: true };
  } catch (error) {
    console.error("Error removing from watchlist:", error);
    throw new Error("Failed to remove from watchlist");
  }
}
