/// <reference types="jest" />
import ShortsNotFound from "../not-found";
import StockNotFound from "../[stockCode]/not-found";

describe("/shorts not-found boundary", () => {
  // A segment's not-found boundary sits INSIDE its own layout, so a notFound()
  // thrown by the [stockCode] layout is caught one level up. Without this file
  // that is the root 404, not the stock card.
  it("is the stock card, so a notFound() from the [stockCode] layout renders it", () => {
    expect(ShortsNotFound).toBe(StockNotFound);
  });
});
