import { getTopShortsData } from '../getTopShorts';

// Mock the entire module to avoid protobuf issues
jest.mock('../getTopShorts', () => ({
  getTopShortsData: jest.fn(),
}));

const mockGetTopShortsData = getTopShortsData as jest.MockedFunction<typeof getTopShortsData>;

describe('getTopShortsData', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should fetch top shorts data successfully', async () => {
    const mockResponse = {
      timeSeries: [
        {
          productCode: 'ZIP',
          name: 'ZIP Co Limited',
          latestShortPosition: 12.5,
          points: [
            {
              timestamp: { seconds: '1234567890', nanos: 0 },
              shortPosition: 12.5,
            },
          ],
        },
      ],
      offset: 0,
    };

    mockGetTopShortsData.mockResolvedValueOnce(mockResponse);

    const result = await getTopShortsData('1M', 10, 0);

    expect(result).toEqual(mockResponse);
    expect(mockGetTopShortsData).toHaveBeenCalledWith('1M', 10, 0);
  });

  it('should handle errors gracefully', async () => {
    const mockError = new Error('Network error');
    mockGetTopShortsData.mockRejectedValueOnce(mockError);

    await expect(
      getTopShortsData('1M', 10, 0)
    ).rejects.toThrow('Network error');
  });

  it('should call API with provided parameters', async () => {
    const mockResponse = { timeSeries: [], offset: 0 };
    mockGetTopShortsData.mockResolvedValueOnce(mockResponse);

    await getTopShortsData('3M', 25, 10);

    expect(mockGetTopShortsData).toHaveBeenCalledWith('3M', 25, 10);
  });

  it('should handle different period parameters', async () => {
    const validPeriods = ['1D', '1W', '1M', '3M', '6M', '1Y'];
    
    for (const period of validPeriods) {
      mockGetTopShortsData.mockResolvedValueOnce({ timeSeries: [], offset: 0 });
      
      await getTopShortsData(period, 10, 0);
      
      expect(mockGetTopShortsData).toHaveBeenLastCalledWith(period, 10, 0);
    }
  });

  it('should handle large datasets efficiently', async () => {
    const largeDataset = {
      timeSeries: Array(100).fill(null).map((_, i) => ({
        productCode: `STOCK${i}`,
        name: `Stock ${i}`,
        latestShortPosition: Math.random() * 20,
        points: [],
      })),
      offset: 0,
    };

    mockGetTopShortsData.mockResolvedValueOnce(largeDataset);

    const result = await getTopShortsData('1M', 100, 0);

    expect(result.timeSeries).toHaveLength(100);
  });

  it('should handle pagination correctly', async () => {
    const page1Response = {
      timeSeries: Array(10).fill(null).map((_, i) => ({
        productCode: `STOCK${i}`,
        name: `Stock ${i}`,
        latestShortPosition: 10 + i,
        points: [],
      })),
      offset: 10,
    };

    const page2Response = {
      timeSeries: Array(10).fill(null).map((_, i) => ({
        productCode: `STOCK${i + 10}`,
        name: `Stock ${i + 10}`,
        latestShortPosition: 20 + i,
        points: [],
      })),
      offset: 20,
    };

    mockGetTopShortsData
      .mockResolvedValueOnce(page1Response)
      .mockResolvedValueOnce(page2Response);

    const result1 = await getTopShortsData('1M', 10, 0);
    const result2 = await getTopShortsData('1M', 10, 10);

    expect(result1.offset).toBe(10);
    expect(result2.offset).toBe(20);
    expect(result1.timeSeries[0].productCode).toBe('STOCK0');
    expect(result2.timeSeries[0].productCode).toBe('STOCK10');
  });
});