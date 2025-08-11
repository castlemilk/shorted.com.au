const vi = { fn: jest.fn };

// Mock Connect RPC types
export interface MockRequest<T> {
  msg: T;
}

export interface MockResponse<T> {
  msg: T;
}

// Mock transport
export const mockTransport = {
  baseUrl: 'http://localhost:9091',
};

// Mock client factory
export const createMockPromiseClient = <T extends Record<string, any>>(
  service: any,
  transport: any
): T => {
  const mockClient = {} as T;
  
  // Add mock methods based on service definition
  if (service.typeName === 'shorts.v1alpha1.ShortedStocksService') {
    Object.assign(mockClient, {
      getTopShorts: vi.fn(),
      getStock: vi.fn(),
      getStockDetails: vi.fn(),
      getStockData: vi.fn(),
      getIndustryTreeMap: vi.fn(),
    });
  }
  
  if (service.typeName === 'register.v1.RegistrationService') {
    Object.assign(mockClient, {
      registerEmail: vi.fn(),
    });
  }
  
  return mockClient;
};

// Mock error types
export class ConnectError extends Error {
  constructor(
    public code: string,
    message: string,
    public metadata?: Record<string, string>
  ) {
    super(message);
    this.name = 'ConnectError';
  }
}

export const Code = {
  Canceled: 'canceled',
  Unknown: 'unknown',
  InvalidArgument: 'invalid_argument',
  DeadlineExceeded: 'deadline_exceeded',
  NotFound: 'not_found',
  AlreadyExists: 'already_exists',
  PermissionDenied: 'permission_denied',
  ResourceExhausted: 'resource_exhausted',
  FailedPrecondition: 'failed_precondition',
  Aborted: 'aborted',
  OutOfRange: 'out_of_range',
  Unimplemented: 'unimplemented',
  Internal: 'internal',
  Unavailable: 'unavailable',
  DataLoss: 'data_loss',
  Unauthenticated: 'unauthenticated',
} as const;

// Mock Connect functions
export const createConnectTransport = vi.fn(() => mockTransport);
export const createPromiseClient = vi.fn(createMockPromiseClient);

// Helper to create mock responses
export function createMockResponse<T>(data: T): MockResponse<T> {
  return { msg: data };
}

// Helper to create mock requests
export function createMockRequest<T>(data: T): MockRequest<T> {
  return { msg: data };
}

// Mock interceptor
export const mockInterceptor = vi.fn((next) => next);

// Reset all mocks
export const resetConnectMocks = () => {
  createConnectTransport.mockClear();
  createPromiseClient.mockClear();
  mockInterceptor.mockClear();
};