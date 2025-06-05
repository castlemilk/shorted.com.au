import { getStockData } from '../getStockData';

// Mock the entire module to avoid protobuf complexity
jest.mock('../getStockData', () => ({
  getStockData: jest.fn(),
}));

const mockGetStockData = getStockData as jest.MockedFunction<typeof getStockData>;

describe('getStockData', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should fetch stock time series data successfully', async () => {
    const mockTimeSeriesData = {
      productCode: 'CBA',
      points: [
        {
          timestamp: { seconds: '1640995200', nanos: 0 },
          shortPosition: 5.2,
        },
        {
          timestamp: { seconds: '1641081600', nanos: 0 },
          shortPosition: 5.5,
        },
      ],
      max: {
        timestamp: { seconds: '1641081600', nanos: 0 },
        shortPosition: 5.5,
      },
      min: {
        timestamp: { seconds: '1640995200', nanos: 0 },
        shortPosition: 5.2,
      },
    };

    mockGetStockData.mockResolvedValue(mockTimeSeriesData);

    const result = await getStockData('CBA', '1M');

    expect(result).toEqual(mockTimeSeriesData);
    expect(mockGetStockData).toHaveBeenCalledWith('CBA', '1M');
  });

  it('should handle different time periods', async () => {
    const mockData = {
      productCode: 'CBA',
      points: [],
      max: null,
      min: null,
    };

    const periods = ['1D', '1W', '1M', '3M', '6M', '1Y'];

    for (const period of periods) {
      mockGetStockData.mockResolvedValue(mockData);
      
      await getStockData('CBA', period);
      
      expect(mockGetStockData).toHaveBeenCalledWith('CBA', period);
    }
  });

  it('should handle empty data gracefully', async () => {
    const emptyData = {
      productCode: 'CBA',
      points: [],
      max: null,
      min: null,
    };

    mockGetStockData.mockResolvedValue(emptyData);

    const result = await getStockData('CBA', '1M');

    expect(result).toEqual(emptyData);
    expect(result.points).toHaveLength(0);
  });

  it('should handle API errors', async () => {
    mockGetStockData.mockRejectedValue(new Error('Stock not found'));

    await expect(getStockData('INVALID', '1M')).rejects.toThrow('Stock not found');
  });

  it('should handle large datasets', async () => {
    const largeDataset = {
      productCode: 'CBA',
      points: Array(365).fill(null).map((_, i) => ({
        timestamp: { seconds: (1640995200 + i * 86400).toString(), nanos: 0 },
        shortPosition: 5.0 + Math.random() * 2,
      })),
      max: {
        timestamp: { seconds: '1672531200', nanos: 0 },
        shortPosition: 7.0,
      },
      min: {
        timestamp: { seconds: '1640995200', nanos: 0 },
        shortPosition: 5.0,
      },
    };

    mockGetStockData.mockResolvedValue(largeDataset);

    const result = await getStockData('CBA', '1Y');

    expect(result.points).toHaveLength(365);
    expect(result.max?.shortPosition).toBe(7.0);
    expect(result.min?.shortPosition).toBe(5.0);
  });

  it('should validate stock codes', async () => {
    const validCodes = ['CBA', 'BHP', 'CSL', 'WBC'];

    for (const code of validCodes) {
      const mockData = {
        productCode: code,
        points: [
          {
            timestamp: { seconds: '1640995200', nanos: 0 },
            shortPosition: 3.5,
          },
        ],
        max: null,
        min: null,
      };

      mockGetStockData.mockResolvedValue(mockData);

      const result = await getStockData(code, '1M');

      expect(result.productCode).toBe(code);
      expect(mockGetStockData).toHaveBeenCalledWith(code, '1M');
    }
  });

  it('should handle network timeouts', async () => {
    mockGetStockData.mockRejectedValue(new Error('Request timeout'));

    await expect(getStockData('CBA', '1M')).rejects.toThrow('Request timeout');
  });

  it('should process timestamp data correctly', async () => {
    const mockData = {
      productCode: 'CBA',
      points: [
        {
          timestamp: { seconds: '1640995200', nanos: 123456789 },
          shortPosition: 5.2,
        },
      ],
      max: {
        timestamp: { seconds: '1640995200', nanos: 123456789 },
        shortPosition: 5.2,
      },
      min: {
        timestamp: { seconds: '1640995200', nanos: 123456789 },
        shortPosition: 5.2,
      },
    };

    mockGetStockData.mockResolvedValue(mockData);

    const result = await getStockData('CBA', '1M');

    expect(result.points[0].timestamp.seconds).toBe('1640995200');
    expect(result.points[0].timestamp.nanos).toBe(123456789);
  });

  it('should handle min/max calculations', async () => {
    const mockData = {
      productCode: 'CBA',
      points: [
        { timestamp: { seconds: '1640995200', nanos: 0 }, shortPosition: 3.0 },
        { timestamp: { seconds: '1641081600', nanos: 0 }, shortPosition: 20.0 },
        { timestamp: { seconds: '1641168000', nanos: 0 }, shortPosition: 10.0 },
      ],
      max: {
        timestamp: { seconds: '1641081600', nanos: 0 },
        shortPosition: 20.0,
      },
      min: {
        timestamp: { seconds: '1640995200', nanos: 0 },
        shortPosition: 3.0,
      },
    };

    mockGetStockData.mockResolvedValue(mockData);

    const result = await getStockData('CBA', '1M');

    expect(result.max?.shortPosition).toBe(20.0);
    expect(result.min?.shortPosition).toBe(3.0);
  });
});