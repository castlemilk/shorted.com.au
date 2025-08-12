import { describe, it, expect } from '@jest/globals';
import { cn, formatNumber } from '../../@/lib/utils';

// Additional utility functions that should be in utils.ts
const formatCurrency = (value: number, currency = 'USD'): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(value);
};

const formatPercentage = (value: number, decimals = 2): string => {
  return `${(value * 100).toFixed(decimals)}%`;
};

const formatDate = (date: Date | string, format = 'short'): string => {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  
  if (format === 'short') {
    return dateObj.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  
  return dateObj.toLocaleDateString('en-US');
};

const calculatePercentageChange = (oldValue: number, newValue: number): number => {
  if (oldValue === 0) return 0;
  return (newValue - oldValue) / oldValue;
};

const debounce = <T extends (...args: any[]) => void>(
  func: T,
  delay: number
): ((...args: Parameters<T>) => void) => {
  let timeoutId: NodeJS.Timeout;
  
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func(...args), delay);
  };
};

const validateStockCode = (code: string): boolean => {
  if (!code || typeof code !== 'string') return false;
  // Don't trim - we want to reject codes with spaces
  return /^[A-Z]{3,4}$/.test(code);
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};

describe('Utility Functions', () => {
  describe('cn', () => {
    it('combines class names correctly', () => {
      expect(cn('foo', 'bar')).toBe('foo bar');
    });

    it('merges tailwind classes correctly', () => {
      // twMerge handles class conflicts, but order may vary
      const result1 = cn('px-2 py-1', 'px-4');
      expect(result1).toContain('py-1');
      expect(result1).toContain('px-4');
      expect(result1).not.toContain('px-2');
      
      expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
    });

    it('handles empty inputs', () => {
      expect(cn()).toBe('');
      expect(cn('')).toBe('');
    });
  });

  describe('formatNumber', () => {
    it('formats billions correctly', () => {
      expect(formatNumber(1000000000)).toBe('1B');
      expect(formatNumber(2500000000)).toBe('2.5B');
      expect(formatNumber(1230000000, 2)).toBe('1.23B');
    });

    it('formats millions correctly', () => {
      expect(formatNumber(1000000)).toBe('1M');
      expect(formatNumber(2500000)).toBe('2.5M');
      expect(formatNumber(1230000, 2)).toBe('1.23M');
    });

    it('formats thousands correctly', () => {
      expect(formatNumber(1000)).toBe('1K');
      expect(formatNumber(2500)).toBe('2.5K');
      expect(formatNumber(1230, 2)).toBe('1.23K');
    });

    it('returns string for small numbers', () => {
      expect(formatNumber(999)).toBe('999');
      expect(formatNumber(0)).toBe('0');
      expect(formatNumber(42)).toBe('42');
    });

    it('removes trailing .0', () => {
      expect(formatNumber(1000000, 1)).toBe('1M');
      expect(formatNumber(2000000, 1)).toBe('2M');
    });
  });
  describe('formatCurrency', () => {
    it('formats positive numbers correctly', () => {
      expect(formatCurrency(1234.56)).toBe('$1,234.56');
      expect(formatCurrency(0)).toBe('$0.00');
      expect(formatCurrency(0.99)).toBe('$0.99');
    });

    it('formats negative numbers correctly', () => {
      expect(formatCurrency(-1234.56)).toBe('-$1,234.56');
    });

    it('supports different currencies', () => {
      expect(formatCurrency(1234.56, 'AUD')).toBe('A$1,234.56');
      expect(formatCurrency(1234.56, 'EUR')).toBe('€1,234.56');
    });

    it('handles large numbers', () => {
      expect(formatCurrency(1000000)).toBe('$1,000,000.00');
    });
  });

  describe('formatPercentage', () => {
    it('formats percentages with default decimals', () => {
      expect(formatPercentage(0.1234)).toBe('12.34%');
      expect(formatPercentage(0.5)).toBe('50.00%');
      expect(formatPercentage(1)).toBe('100.00%');
    });

    it('formats percentages with custom decimals', () => {
      expect(formatPercentage(0.1234, 1)).toBe('12.3%');
      expect(formatPercentage(0.1234, 0)).toBe('12%');
      expect(formatPercentage(0.1234, 4)).toBe('12.3400%');
    });

    it('handles negative percentages', () => {
      expect(formatPercentage(-0.1234)).toBe('-12.34%');
    });

    it('handles zero', () => {
      expect(formatPercentage(0)).toBe('0.00%');
    });
  });

  describe('formatDate', () => {
    const testDate = new Date('2023-06-15T10:30:00Z');

    it('formats date with short format', () => {
      const result = formatDate(testDate, 'short');
      expect(result).toMatch(/Jun 15, 2023/);
    });

    it('formats date with default format', () => {
      const result = formatDate(testDate);
      expect(result).toMatch(/Jun 15, 2023/);
    });

    it('handles string dates', () => {
      const result = formatDate('2023-06-15', 'short');
      expect(result).toMatch(/Jun 15, 2023/);
    });

    it('formats date with long format', () => {
      const result = formatDate(testDate, 'long');
      expect(result).toMatch(/6\/15\/2023/);
    });
  });

  describe('calculatePercentageChange', () => {
    it('calculates positive percentage change', () => {
      expect(calculatePercentageChange(100, 110)).toBe(0.1);
      expect(calculatePercentageChange(50, 75)).toBe(0.5);
    });

    it('calculates negative percentage change', () => {
      expect(calculatePercentageChange(100, 90)).toBe(-0.1);
      expect(calculatePercentageChange(100, 50)).toBe(-0.5);
    });

    it('handles zero old value', () => {
      expect(calculatePercentageChange(0, 100)).toBe(0);
    });

    it('handles same values', () => {
      expect(calculatePercentageChange(100, 100)).toBe(0);
    });

    it('handles decimal values', () => {
      expect(calculatePercentageChange(1.5, 1.65)).toBeCloseTo(0.1);
    });
  });

  describe('debounce', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('delays function execution', () => {
      const mockFn = jest.fn();
      const debouncedFn = debounce(mockFn, 100);

      debouncedFn('test');
      expect(mockFn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(100);
      expect(mockFn).toHaveBeenCalledWith('test');
    });

    it('cancels previous calls', () => {
      const mockFn = jest.fn();
      const debouncedFn = debounce(mockFn, 100);

      debouncedFn('first');
      jest.advanceTimersByTime(50);
      debouncedFn('second');
      jest.advanceTimersByTime(100);

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(mockFn).toHaveBeenCalledWith('second');
    });
  });

  describe('validateStockCode', () => {
    it('validates correct stock codes', () => {
      expect(validateStockCode('CBA')).toBe(true);
      expect(validateStockCode('AAPL')).toBe(true);
      expect(validateStockCode('ZIP')).toBe(true);
    });

    it('rejects invalid stock codes', () => {
      expect(validateStockCode('AB')).toBe(false); // too short
      expect(validateStockCode('ABCDE')).toBe(false); // too long
      expect(validateStockCode('ab3')).toBe(false); // lowercase and number
      expect(validateStockCode('123')).toBe(false); // numbers
      expect(validateStockCode('')).toBe(false); // empty
      expect(validateStockCode(' CBA ')).toBe(false); // with spaces
    });

    it('handles non-string inputs', () => {
      expect(validateStockCode(null as any)).toBe(false);
      expect(validateStockCode(undefined as any)).toBe(false);
      expect(validateStockCode(123 as any)).toBe(false);
    });
  });

  describe('clamp', () => {
    it('clamps values within range', () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-5, 0, 10)).toBe(0);
      expect(clamp(15, 0, 10)).toBe(10);
    });

    it('handles edge cases', () => {
      expect(clamp(0, 0, 10)).toBe(0);
      expect(clamp(10, 0, 10)).toBe(10);
    });

    it('handles decimal values', () => {
      expect(clamp(1.5, 1, 2)).toBe(1.5);
      expect(clamp(0.5, 1, 2)).toBe(1);
      expect(clamp(2.5, 1, 2)).toBe(2);
    });
  });
});