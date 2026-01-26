import {
  getPortfolio,
  savePortfolio,
  addHolding,
  removeHolding,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  type PortfolioHolding,
  type WatchlistItem,
} from "@/app/actions/portfolio";

class PortfolioService {
  // Portfolio methods
  async getPortfolio() {
    return await getPortfolio();
  }

  async savePortfolio(holdings: PortfolioHolding[]) {
    const result = await savePortfolio(holdings);
    if (!result.success) {
      throw new Error("Failed to save portfolio");
    }
  }

  async addHolding(holding: PortfolioHolding) {
    const result = await addHolding(holding);
    if (!result.success) {
      throw new Error("Failed to add holding");
    }
  }

  async removeHolding(symbol: string) {
    const result = await removeHolding(symbol);
    if (!result.success) {
      throw new Error("Failed to remove holding");
    }
  }

  // Watchlist methods
  async getWatchlist() {
    return await getWatchlist();
  }

  async addToWatchlist(symbol: string) {
    const result = await addToWatchlist(symbol);
    if (!result.success) {
      throw new Error("Failed to add to watchlist");
    }
    return result;
  }

  async removeFromWatchlist(symbol: string) {
    const result = await removeFromWatchlist(symbol);
    if (!result.success) {
      throw new Error("Failed to remove from watchlist");
    }
  }

  // Migration helper - one-time use to migrate from localStorage
  async migrateFromLocalStorage() {
    if (typeof window === 'undefined') return;
    
    const savedPortfolio = localStorage.getItem('portfolio');
    if (savedPortfolio) {
      try {
        const holdings = JSON.parse(savedPortfolio) as PortfolioHolding[];
        await this.savePortfolio(holdings);
        
        // Remove from localStorage after successful migration
        localStorage.removeItem('portfolio');
        console.log('Portfolio migrated to Firebase successfully');
      } catch (error) {
        console.error('Failed to migrate portfolio:', error);
      }
    }
  }
}

export const portfolioService = new PortfolioService();

// Re-export types for convenience
export type { PortfolioHolding, WatchlistItem };