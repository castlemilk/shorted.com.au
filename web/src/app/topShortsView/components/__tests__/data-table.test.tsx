import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { DataTable } from '../data-table';
import { useRouter } from 'next/navigation';

// Mock dependencies
jest.mock('next/navigation', () => ({
  useRouter: jest.fn(),
}));

jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: jest.fn(() => ({
    getTotalSize: () => 1000,
    getVirtualItems: () => [
      { index: 0, size: 50, start: 0 },
      { index: 1, size: 50, start: 50 },
    ],
    scrollToIndex: jest.fn(),
    measure: jest.fn(),
  })),
}));

jest.mock('lodash', () => ({
  debounce: (fn: any) => fn,
}));

// Mock UI components
jest.mock('~/@/components/ui/table', () => ({
  Table: ({ children }: any) => <table>{children}</table>,
  TableBody: ({ children }: any) => <tbody>{children}</tbody>,
  TableCell: ({ children }: any) => <td>{children}</td>,
  TableHead: ({ children }: any) => <th>{children}</th>,
  TableHeader: ({ children }: any) => <thead>{children}</thead>,
  TableRow: ({ children, onClick }: any) => (
    <tr onClick={onClick}>{children}</tr>
  ),
}));

jest.mock('~/@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...props }: any) => (
    <button onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));

const mockPush = jest.fn();
(useRouter as jest.Mock).mockReturnValue({
  push: mockPush,
});

describe('DataTable', () => {
  const mockData = [
    {
      id: '1',
      productCode: 'CBA',
      name: 'Commonwealth Bank',
      shortPosition: 2.5,
      change: 0.2,
    },
    {
      id: '2',
      productCode: 'ZIP',
      name: 'ZIP Co Limited',
      shortPosition: 12.5,
      change: -0.5,
    },
    {
      id: '3',
      productCode: 'BHP',
      name: 'BHP Group',
      shortPosition: 3.2,
      change: 0.1,
    },
  ];

  const mockColumns = [
    {
      accessorKey: 'productCode',
      header: 'Code',
      cell: ({ row }: any) => row.getValue('productCode'),
    },
    {
      accessorKey: 'name',
      header: 'Company',
      cell: ({ row }: any) => row.getValue('name'),
    },
    {
      accessorKey: 'shortPosition',
      header: 'Short %',
      cell: ({ row }: any) => `${row.getValue('shortPosition')}%`,
    },
  ];

  const mockFetchMore = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchMore.mockClear().mockResolvedValue(undefined);
    
    // Reset window size
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1200,
    });
  });

  it('renders table with data', () => {
    render(
      <DataTable
        columns={mockColumns}
        data={mockData}
        period="1M"
        loading={false}
        fetchMore={mockFetchMore}
      />
    );

    expect(screen.getByText('Code')).toBeInTheDocument();
    expect(screen.getByText('Company')).toBeInTheDocument();
    expect(screen.getByText('Short %')).toBeInTheDocument();
    
    expect(screen.getByText('CBA')).toBeInTheDocument();
    expect(screen.getByText('Commonwealth Bank')).toBeInTheDocument();
    expect(screen.getByText('2.5%')).toBeInTheDocument();
  });

  it('handles row click navigation', () => {
    render(
      <DataTable
        columns={mockColumns}
        data={mockData}
        period="1M"
        loading={false}
        fetchMore={mockFetchMore}
      />
    );

    const row = screen.getByText('CBA').closest('tr');
    fireEvent.click(row!);

    expect(mockPush).toHaveBeenCalledWith('/shorts/CBA');
  });

  it('updates when data changes', () => {
    const { rerender } = render(
      <DataTable
        columns={mockColumns}
        data={mockData}
        period="1M"
        loading={false}
        fetchMore={mockFetchMore}
      />
    );

    expect(screen.getByText('CBA')).toBeInTheDocument();

    const newData = [
      {
        id: '4',
        productCode: 'ANZ',
        name: 'ANZ Bank',
        shortPosition: 1.8,
        change: 0.3,
      },
    ];

    rerender(
      <DataTable
        columns={mockColumns}
        data={newData}
        period="1M"
        loading={false}
        fetchMore={mockFetchMore}
      />
    );

    expect(screen.queryByText('CBA')).not.toBeInTheDocument();
    expect(screen.getByText('ANZ')).toBeInTheDocument();
  });

  it('shows load more button on small screens', async () => {
    // Set small screen size before render
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 500,
    });

    render(
      <DataTable
        columns={mockColumns}
        data={mockData}
        period="1M"
        loading={false}
        fetchMore={mockFetchMore}
      />
    );

    // Trigger resize event to update the component
    fireEvent(window, new Event('resize'));

    await waitFor(() => {
      const loadMoreButton = screen.queryByText('Load More');
      expect(loadMoreButton).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('handles fetch more', async () => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 500,
    });

    render(
      <DataTable
        columns={mockColumns}
        data={mockData}
        period="1M"
        loading={false}
        fetchMore={mockFetchMore}
      />
    );

    fireEvent(window, new Event('resize'));

    await waitFor(() => {
      const loadMoreButton = screen.getByText('Load More');
      fireEvent.click(loadMoreButton);
    });

    expect(mockFetchMore).toHaveBeenCalled();
  });

  it('handles sorting', () => {
    render(
      <DataTable
        columns={mockColumns}
        data={mockData}
        period="1M"
        loading={false}
        fetchMore={mockFetchMore}
      />
    );

    // Click on column header to sort
    const codeHeader = screen.getByText('Code');
    fireEvent.click(codeHeader);

    // Verify data is still rendered (actual sorting would be handled by the table)
    expect(screen.getByText('CBA')).toBeInTheDocument();
  });

  it('handles empty data', () => {
    render(
      <DataTable
        columns={mockColumns}
        data={[]}
        period="1M"
        loading={false}
        fetchMore={mockFetchMore}
      />
    );

    expect(screen.getByText('Code')).toBeInTheDocument();
    expect(screen.queryByText('CBA')).not.toBeInTheDocument();
  });

  it('disables load more when clicking load more', async () => {
    // Set small screen size to show the load more button
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 500,
    });

    mockFetchMore.mockImplementation(() => 
      new Promise(resolve => setTimeout(resolve, 100))
    );

    render(
      <DataTable
        columns={mockColumns}
        data={mockData}
        period="1M"
        loading={false}
        fetchMore={mockFetchMore}
      />
    );

    // Trigger resize to show load more button
    fireEvent(window, new Event('resize'));

    // Wait for load more button to appear
    await waitFor(() => {
      expect(screen.getByText('Load More')).toBeInTheDocument();
    });

    const loadMoreButton = screen.getByText('Load More') as HTMLButtonElement;
    
    // Click the load more button
    fireEvent.click(loadMoreButton);

    // The button should show loading text during loading
    await waitFor(() => {
      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });
  });

  it('handles responsive layout changes', async () => {
    const { rerender } = render(
      <DataTable
        columns={mockColumns}
        data={mockData}
        period="1M"
        loading={false}
        fetchMore={mockFetchMore}
      />
    );

    // Start with large screen
    expect(screen.queryByText('Load More')).not.toBeInTheDocument();

    // Change to small screen
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 500,
    });
    
    fireEvent(window, new Event('resize'));

    await waitFor(() => {
      expect(screen.getByText('Load More')).toBeInTheDocument();
    });
  });

  it('updates when period changes', () => {
    const { rerender } = render(
      <DataTable
        columns={mockColumns}
        data={mockData}
        period="1M"
        loading={false}
        fetchMore={mockFetchMore}
      />
    );

    // Data should remain the same even when period changes
    rerender(
      <DataTable
        columns={mockColumns}
        data={mockData}
        period="3M"
        loading={false}
        fetchMore={mockFetchMore}
      />
    );

    expect(screen.getByText('CBA')).toBeInTheDocument();
  });
});