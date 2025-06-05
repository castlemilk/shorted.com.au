import '@testing-library/jest-dom';

// Mock React Server Components functions
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  cache: jest.fn((fn) => fn),
  experimental_taintUniqueValue: jest.fn(),
}));

// Mock Next.js modules
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
  notFound: jest.fn(),
  redirect: jest.fn(),
}));

jest.mock('next/headers', () => ({
  headers: () => new Map(),
  cookies: () => ({
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
  }),
}));

// Mock protobuf dependencies
jest.mock('@bufbuild/protobuf', () => ({
  Message: class MockMessage {
    constructor(data?: any) {
      Object.assign(this, data);
    }
    static fromJson(json: any) {
      return new MockMessage(json);
    }
    toJson() {
      return this;
    }
  },
  toPlainMessage: jest.fn((msg) => msg || {}),
  fromPlainMessage: jest.fn((schema, data) => data || {}),
  create: jest.fn((schema, data) => data || {}),
}));

// Mock Connect RPC
jest.mock('@connectrpc/connect', () => ({
  createPromiseClient: jest.fn(() => ({
    getTopShorts: jest.fn(),
    getStock: jest.fn(), 
    getStockData: jest.fn(),
    getStockDetails: jest.fn(),
    getIndustryTreeMap: jest.fn(),
  })),
  Code: {
    Unknown: 'UNKNOWN',
    InvalidArgument: 'INVALID_ARGUMENT',
    NotFound: 'NOT_FOUND',
  },
  ConnectError: class MockConnectError extends Error {
    code: string;
    constructor(message: string, code = 'UNKNOWN') {
      super(message);
      this.code = code;
    }
  },
}));

jest.mock('@connectrpc/connect-web', () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

// Mock common actions
jest.mock('~/app/actions/getStockData', () => ({
  getStockData: jest.fn().mockResolvedValue({
    productCode: 'TEST',
    points: [],
    max: null,
    min: null,
  }),
}));

jest.mock('~/app/actions/getTopShorts', () => ({
  getTopShortsData: jest.fn().mockResolvedValue({
    timeSeries: [],
    offset: 0,
  }),
}));

jest.mock('~/app/actions/getStock', () => ({
  getStock: jest.fn().mockResolvedValue({
    productCode: 'TEST',
    name: 'Test Stock',
    totalProductInIssue: 1000000,
    reportedShortPositions: 50000,
    percentageShorted: 5.0,
  }),
}));

// Mock environment variables
process.env = {
  ...process.env,
  NEXTAUTH_SECRET: 'test-secret',
  NEXTAUTH_URL: 'http://localhost:3000',
  SHORTS_SERVICE_ENDPOINT: 'http://localhost:8080',
};

// Global test utilities
global.ResizeObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  unobserve: jest.fn(),
  disconnect: jest.fn(),
}));

// Mock IntersectionObserver
global.IntersectionObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  unobserve: jest.fn(),
  disconnect: jest.fn(),
}));

// Console error suppression for expected test warnings
const originalError = console.error;
beforeAll(() => {
  console.error = (...args: any[]) => {
    if (
      typeof args[0] === 'string' &&
      (args[0].includes('Warning: ReactDOM.render is no longer supported') ||
       args[0].includes('Warning: validateDOMNesting') ||
       args[0].includes('cannot appear as a child of'))
    ) {
      return;
    }
    originalError.call(console, ...args);
  };
});

afterAll(() => {
  console.error = originalError;
});