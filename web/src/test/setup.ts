import '@testing-library/jest-dom';

// Mock class-variance-authority
jest.mock('class-variance-authority', () => ({
  cva: jest.fn((base, config) => {
    return jest.fn((props) => {
      // Return a string that includes base classes and variant classes
      let classes = base || '';
      if (props && config && config.variants) {
        const { variant, size, className } = props || {};
        // Add variant classes
        if (variant && config.variants.variant && config.variants.variant[variant]) {
          classes += ' ' + config.variants.variant[variant];
        }
        // Add size classes
        if (size && config.variants.size && config.variants.size[size]) {
          classes += ' ' + config.variants.size[size];
        }
        // Add custom classes
        if (className) {
          classes += ' ' + className;
        }
      }
      return classes.trim();
    });
  }),
  type: jest.fn(),
}));

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

// Mock NextAuth
jest.mock('next-auth', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    handlers: jest.fn(),
    signIn: jest.fn(),
    signOut: jest.fn(),
    auth: jest.fn(),
  })),
  getServerSession: jest.fn(),
}));

jest.mock('next-auth/providers/google', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    id: 'google',
    name: 'Google',
    type: 'oauth',
  })),
}));

jest.mock('next-auth/providers/credentials', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    id: 'credentials',
    name: 'credentials',
    type: 'credentials',
  })),
}));

// Mock Firebase adapter - handled via moduleNameMapper

// @/auth mock is handled via moduleNameMapper

// Mock Firebase admin
jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    credential: {
      cert: jest.fn(() => ({})),
    },
    apps: [],
    initializeApp: jest.fn(() => ({})),
  },
  credential: {
    cert: jest.fn(() => ({})),
  },
}));

// Mock Firebase admin/firestore
jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  default: jest.fn(() => ({})),
  getFirestore: jest.fn(() => ({})),
}));

// Mock UI components
jest.mock('@/components/ui/button', () => ({
  __esModule: true,
  Button: jest.fn(({ children, onClick, className, ...props }) => {
    const React = require('react');
    return React.createElement('button', {
      onClick,
      className,
      ...props
    }, children);
  }),
  buttonVariants: jest.fn(),
}));

jest.mock('@/components/ui/card', () => ({
  __esModule: true,
  Card: jest.fn(({ children, className }) => {
    const React = require('react');
    return React.createElement('div', { className }, children);
  }),
}));

jest.mock('lucide-react', () => ({
  AlertCircle: jest.fn(({ className }) => {
    const React = require('react');
    return React.createElement('div', { className: `alert-circle ${className}` });
  }),
  RefreshCw: jest.fn(({ className }) => {
    const React = require('react');
    return React.createElement('div', { className: `refresh-cw ${className}` });
  }),
  Plus: jest.fn(({ className }) => {
    const React = require('react');
    return React.createElement('div', { className: `plus ${className}` });
  }),
  X: jest.fn(({ className }) => {
    const React = require('react');
    return React.createElement('div', { className: `x ${className}` });
  }),
}));

// Mock Login Prompt Banner
jest.mock('@/components/ui/login-prompt-banner', () => ({
  __esModule: true,
  LoginPromptBanner: jest.fn(() => {
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'login-prompt-banner' }, 'Login Prompt');
  }),
}));

// Mock utils
jest.mock('@/lib/utils', () => ({
  cn: jest.fn((...args) => args.filter(Boolean).join(' ')),
}));

// Mock d3 modules
jest.mock('d3-array', () => ({
  bisector: jest.fn(() => ({
    left: jest.fn(),
    right: jest.fn(),
  })),
  extent: jest.fn(),
  max: jest.fn(),
  min: jest.fn(),
}));

jest.mock('d3-scale', () => ({
  scaleLinear: jest.fn(() => ({
    domain: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    invert: jest.fn(),
  })),
  scaleTime: jest.fn(() => ({
    domain: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    invert: jest.fn(),
  })),
}));

// Mock visx modules
jest.mock('@visx/gradient', () => ({
  LinearGradient: jest.fn(() => null),
}));

jest.mock('@visx/event', () => ({
  localPoint: jest.fn(() => ({ x: 0, y: 0 })),
}));

jest.mock('@visx/tooltip', () => ({
  Tooltip: jest.fn(() => null),
  TooltipWithBounds: jest.fn(() => null),
  useTooltip: jest.fn(() => ({
    tooltipData: null,
    tooltipLeft: 0,
    tooltipTop: 0,
    showTooltip: jest.fn(),
    hideTooltip: jest.fn(),
  })),
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