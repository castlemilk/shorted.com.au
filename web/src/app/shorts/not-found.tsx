// A segment's not-found boundary sits INSIDE its own layout, so a notFound()
// thrown by the [stockCode] layout is caught here, one level up. Re-exporting
// the stock card keeps that 404 the stock card instead of the root one.
export { default } from "./[stockCode]/not-found";
