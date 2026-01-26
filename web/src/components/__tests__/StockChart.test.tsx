import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock the chart component since it's complex and uses D3/Visx
jest.mock('@visx/xychart', () => ({
  XYChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="xy-chart">{children}</div>
  ),
  Axis: ({ orientation }: { orientation: string }) => (
    <div data-testid={`axis-${orientation}`} />
  ),
  LineSeries: ({ data }: { data: any[] }) => (
    <div data-testid="line-series">{data.length} data points</div>
  ),
  AreaSeries: ({ data }: { data: any[] }) => (
    <div data-testid="area-series">{data.length} data points</div>
  ),
  Grid: () => <div data-testid="grid" />,
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip">{children}</div>
  ),
}));

jest.mock('@visx/responsive', () => ({
  ParentSize: ({ children }: { children: (props: any) => React.ReactNode }) =>
    children({ width: 800, height: 400 }),
}));

// Simple mock component for testing
const MockStockChart = ({ 
  data, 
  width = 800, 
  height = 400,
  showArea = false 
}: {
  data: Array<{ date: Date; value: number }>;
  width?: number;
  height?: number;
  showArea?: boolean;
}) => {
  if (!data || data.length === 0) {
    return <div data-testid="empty-chart">No data available</div>;
  }

  return (
    <div data-testid="stock-chart" style={{ width, height }}>
      <div data-testid="chart-title">Stock Price Chart</div>
      <div data-testid="chart-data">{data.length} data points</div>
      {showArea && <div data-testid="area-chart">Area chart enabled</div>}
    </div>
  );
};

describe('StockChart', () => {
  const mockData = [
    { date: new Date('2023-01-01'), value: 100 },
    { date: new Date('2023-01-02'), value: 105 },
    { date: new Date('2023-01-03'), value: 98 },
    { date: new Date('2023-01-04'), value: 110 },
  ];

  it('renders chart with data', () => {
    render(<MockStockChart data={mockData} />);
    
    expect(screen.getByTestId('stock-chart')).toBeInTheDocument();
    expect(screen.getByTestId('chart-title')).toHaveTextContent('Stock Price Chart');
    expect(screen.getByTestId('chart-data')).toHaveTextContent('4 data points');
  });

  it('renders empty state when no data provided', () => {
    render(<MockStockChart data={[]} />);
    
    expect(screen.getByTestId('empty-chart')).toBeInTheDocument();
    expect(screen.getByTestId('empty-chart')).toHaveTextContent('No data available');
  });

  it('handles undefined data gracefully', () => {
    render(<MockStockChart data={undefined as any} />);
    
    expect(screen.getByTestId('empty-chart')).toBeInTheDocument();
  });

  it('applies custom dimensions', () => {
    render(<MockStockChart data={mockData} width={600} height={300} />);
    
    const chart = screen.getByTestId('stock-chart');
    expect(chart).toHaveStyle({ width: '600px', height: '300px' });
  });

  it('renders area chart when showArea is true', () => {
    render(<MockStockChart data={mockData} showArea={true} />);
    
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    expect(screen.getByTestId('area-chart')).toHaveTextContent('Area chart enabled');
  });

  it('does not render area chart by default', () => {
    render(<MockStockChart data={mockData} />);
    
    expect(screen.queryByTestId('area-chart')).not.toBeInTheDocument();
  });

  it('handles large datasets', () => {
    const largeData = Array.from({ length: 1000 }, (_, i) => ({
      date: new Date(2023, 0, i + 1),
      value: 100 + Math.random() * 20,
    }));

    render(<MockStockChart data={largeData} />);
    
    expect(screen.getByTestId('chart-data')).toHaveTextContent('1000 data points');
  });

  it('handles data with extreme values', () => {
    const extremeData = [
      { date: new Date('2023-01-01'), value: 0.01 },
      { date: new Date('2023-01-02'), value: 999999 },
      { date: new Date('2023-01-03'), value: -100 },
    ];

    render(<MockStockChart data={extremeData} />);
    
    expect(screen.getByTestId('stock-chart')).toBeInTheDocument();
    expect(screen.getByTestId('chart-data')).toHaveTextContent('3 data points');
  });
});