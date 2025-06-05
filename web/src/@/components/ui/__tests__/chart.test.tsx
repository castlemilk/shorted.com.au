import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import Chart from '../chart';
import { useStockData } from '../../../hooks/use-stock-data';

// Mock the dependencies
jest.mock('../../../hooks/use-stock-data', () => ({
  useStockData: jest.fn(),
}));

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  cache: (fn: any) => fn,
}));
jest.mock('@visx/responsive/lib/components/ParentSize', () => ({
  __esModule: true,
  default: ({ children }: any) => children({ width: 800, height: 400 }),
}));

const clearMock = jest.fn();
const resetMock = jest.fn();

jest.mock('../brushChart', () => ({
  __esModule: true,
  default: React.forwardRef(({ data, period }: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      clear: clearMock,
      reset: resetMock,
    }));
    return (
      <div data-testid="brush-chart">
        <div>Period: {period}</div>
        <div>Data points: {data?.length || 0}</div>
      </div>
    );
  }),
}));

jest.mock('../toggle-group', () => ({
  ToggleGroup: ({ children, onValueChange }: any) => (
    <div data-testid="toggle-group" onClick={() => onValueChange('1y')}>
      {children}
    </div>
  ),
  ToggleGroupItem: ({ children, value }: any) => (
    <button data-testid={`toggle-${value}`} value={value}>
      {children}
    </button>
  ),
}));

jest.mock('../button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

jest.mock('../skeleton', () => ({
  Skeleton: () => <div data-testid="skeleton">Loading...</div>,
}));

const mockUseStockData = useStockData as jest.MockedFunction<typeof useStockData>;

describe('Chart Component', () => {
  const mockData = [
    { date: new Date('2023-01-01'), value: 10.5 },
    { date: new Date('2023-01-02'), value: 11.2 },
    { date: new Date('2023-01-03'), value: 10.8 },
    { date: new Date('2023-01-04'), value: 12.1 },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    clearMock.mockClear();
    resetMock.mockClear();
    mockUseStockData.mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
    } as any);
  });

  it('renders chart with stock data', () => {
    render(<Chart stockCode="CBA" />);
    
    expect(screen.getByTestId('brush-chart')).toBeInTheDocument();
    expect(screen.getByText('Data points: 4')).toBeInTheDocument();
  });

  it('displays loading state', () => {
    mockUseStockData.mockReturnValue({
      data: null,
      loading: true,
      error: null,
    } as any);

    render(<Chart stockCode="CBA" />);
    
    // Should show skeleton when loading
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
  });

  it('handles error state', () => {
    mockUseStockData.mockReturnValue({
      data: null,
      loading: false,
      error: new Error('Failed to fetch data'),
    } as any);

    render(<Chart stockCode="CBA" />);
    
    // Should show skeleton when there's an error (fallback state)
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
  });

  it('renders period toggle buttons', () => {
    render(<Chart stockCode="CBA" />);
    
    expect(screen.getByTestId('toggle-1m')).toHaveTextContent('1M');
    expect(screen.getByTestId('toggle-3m')).toHaveTextContent('3M');
    expect(screen.getByTestId('toggle-6m')).toHaveTextContent('6M');
    expect(screen.getByTestId('toggle-1y')).toHaveTextContent('1Y');
    expect(screen.getByTestId('toggle-2y')).toHaveTextContent('2Y');
    expect(screen.getByTestId('toggle-max')).toHaveTextContent('max');
  });

  it('changes period when toggle is clicked', async () => {
    render(<Chart stockCode="CBA" />);
    
    const toggleGroup = screen.getByTestId('toggle-group');
    fireEvent.click(toggleGroup);
    
    await waitFor(() => {
      expect(mockUseStockData).toHaveBeenCalledWith('CBA', '1y');
    });
  });

  it('renders clear and reset buttons', () => {
    render(<Chart stockCode="CBA" />);
    
    expect(screen.getByText('Clear')).toBeInTheDocument();
    expect(screen.getByText('Reset')).toBeInTheDocument();
  });

  it('calls clear method when Clear button is clicked', () => {
    render(<Chart stockCode="CBA" />);
    
    const clearButton = screen.getByText('Clear');
    fireEvent.click(clearButton);
    
    expect(clearMock).toHaveBeenCalled();
  });

  it('calls reset method when Reset button is clicked', () => {
    render(<Chart stockCode="CBA" />);
    
    const resetButton = screen.getByText('Reset');
    fireEvent.click(resetButton);
    
    expect(resetMock).toHaveBeenCalled();
  });

  it('uses correct initial period', () => {
    render(<Chart stockCode="CBA" />);
    
    expect(mockUseStockData).toHaveBeenCalledWith('CBA', '6m');
  });

  it('passes stock code to data hook', () => {
    render(<Chart stockCode="ZIP" />);
    
    expect(mockUseStockData).toHaveBeenCalledWith('ZIP', '6m');
  });

  it('handles empty data gracefully', () => {
    mockUseStockData.mockReturnValue({
      data: [],
      loading: false,
      error: null,
    } as any);

    render(<Chart stockCode="CBA" />);
    
    expect(screen.getByText('Data points: 0')).toBeInTheDocument();
  });

  it('updates when stock code changes', () => {
    const { rerender } = render(<Chart stockCode="CBA" />);
    
    expect(mockUseStockData).toHaveBeenCalledWith('CBA', '6m');
    
    rerender(<Chart stockCode="ZIP" />);
    
    expect(mockUseStockData).toHaveBeenCalledWith('ZIP', '6m');
  });
});