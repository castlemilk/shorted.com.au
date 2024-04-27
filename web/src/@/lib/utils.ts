import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
 
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const formatNumber = (num: number, decimalPlaces = 1) => {
  if (num >= 1e9) {
      return (num / 1e9).toFixed(decimalPlaces).replace(/\.0$/, '') + 'B';
  }
  if (num >= 1e6) {
      return (num / 1e6).toFixed(decimalPlaces).replace(/\.0$/, '') + 'M';
  }
  if (num >= 1e3) {
      return (num / 1e3).toFixed(decimalPlaces).replace(/\.0$/, '') + 'K';
  }
  return num.toString();
}
