/**
 * Helper function to convert frontend period format to backend API format
 * Frontend uses lowercase (3m, 6m, 1y) while backend expects uppercase (3M, 6M, 1Y)
 */
export const formatPeriodForAPI = (period: string): string => {
  return period.toUpperCase();
};
