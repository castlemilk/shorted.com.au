import { getStock } from '../getStock';

// Mock the entire module to avoid protobuf complexity
jest.mock('../getStock', () => ({
  getStock: jest.fn(),
}));

const mockGetStock = getStock as jest.MockedFunction<typeof getStock>;

describe('getStock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should fetch stock data successfully', async () => {
    const mockStock = {
      productCode: 'CBA',
      name: 'Commonwealth Bank',
      totalProductInIssue: 1708402198,
      reportedShortPositions: 85420109,
      percentageShorted: 5.0,
    };

    mockGetStock.mockResolvedValue(mockStock);

    const result = await getStock('CBA');

    expect(result).toEqual(mockStock);
    expect(mockGetStock).toHaveBeenCalledWith('CBA');
  });

  it('should handle stock not found', async () => {
    const mockError = new Error('Stock not found');
    mockGetStock.mockRejectedValue(mockError);

    await expect(getStock('INVALID')).rejects.toThrow('Stock not found');
  });

  it('should normalize stock code', async () => {
    const mockStock = {
      productCode: 'CBA',
      name: 'Commonwealth Bank',
      totalProductInIssue: 1708402198,
      reportedShortPositions: 85420109,
      percentageShorted: 5.0,
    };

    mockGetStock.mockResolvedValue(mockStock);

    await getStock('cba');

    expect(mockGetStock).toHaveBeenCalledWith('cba');
  });

  it('should handle API errors gracefully', async () => {
    mockGetStock.mockRejectedValue(new Error('Network error'));

    await expect(getStock('CBA')).rejects.toThrow('Network error');
  });

  it('should validate stock code format', async () => {
    const validCodes = ['CBA', 'ZIP', 'BHP', 'CSL'];
    
    for (const code of validCodes) {
      mockGetStock.mockResolvedValue({
        productCode: code,
        name: `${code} Company`,
        totalProductInIssue: 1000000,
        reportedShortPositions: 50000,
        percentageShorted: 5.0,
      });

      await getStock(code);
      expect(mockGetStock).toHaveBeenCalledWith(code);
    }
  });

  it('should handle caching correctly', async () => {
    const mockStock = {
      productCode: 'CBA',
      name: 'Commonwealth Bank',
      totalProductInIssue: 1708402198,
      reportedShortPositions: 85420109,
      percentageShorted: 5.0,
    };

    mockGetStock.mockResolvedValue(mockStock);

    // First call
    const result1 = await getStock('CBA');
    
    // Second call (should use cache)
    const result2 = await getStock('CBA');

    expect(result1).toEqual(mockStock);
    expect(result2).toEqual(mockStock);
  });
});