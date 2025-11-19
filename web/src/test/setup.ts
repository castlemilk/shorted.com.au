import "@testing-library/jest-dom";
import { TextEncoder, TextDecoder } from "util";

// Polyfill TextEncoder/TextDecoder for Node.js environment
if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === "undefined") {
  // @ts-expect-error - TextDecoder type on Node differs from DOM lib
  globalThis.TextDecoder = TextDecoder;
}

// Polyfill for Next.js Request/Response API
// @ts-expect-error - Polyfill for test environment
global.Request = class Request {
  url: string;
  method: string;
  headers: Map<string, string>;
  body: any;
  bodyUsed: boolean;

  constructor(url: string, init?: any) {
    this.url = url;
    this.method = init?.method || "GET";
    this.headers = new Map();
    this.body = init?.body;
    this.bodyUsed = false;
  }

  async json() {
    if (this.bodyUsed) throw new Error("Body already used");
    this.bodyUsed = true;
    return typeof this.body === "string" ? JSON.parse(this.body) : this.body;
  }

  async text() {
    if (this.bodyUsed) throw new Error("Body already used");
    this.bodyUsed = true;
    return typeof this.body === "string"
      ? this.body
      : JSON.stringify(this.body);
  }
};

// @ts-expect-error - Polyfill for test environment
global.Response = class Response {
  body: any;
  status: number;
  statusText: string;
  headers: Map<string, string>;
  ok: boolean;

  constructor(body?: any, init?: any) {
    this.body = body;
    this.status = init?.status || 200;
    this.statusText = init?.statusText || "OK";
    this.headers = new Map();
    this.ok = this.status >= 200 && this.status < 300;
  }

  async json() {
    return typeof this.body === "string" ? JSON.parse(this.body) : this.body;
  }

  async text() {
    return typeof this.body === "string"
      ? this.body
      : JSON.stringify(this.body);
  }

  static json(data: any, init?: any) {
    return new Response(JSON.stringify(data), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
  }
};

// @ts-expect-error - Polyfill for test environment
global.Headers = class Headers {
  private map: Map<string, string>;

  constructor(init?: any) {
    this.map = new Map();
    if (init) {
      if (init instanceof Headers) {
        this.map = new Map(init.map);
      } else if (typeof init === "object") {
        Object.entries(init).forEach(([key, value]) => {
          this.map.set(key.toLowerCase(), String(value));
        });
      }
    }
  }

  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }

  set(name: string, value: string): void {
    this.map.set(name.toLowerCase(), value);
  }

  has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }

  delete(name: string): void {
    this.map.delete(name.toLowerCase());
  }

  forEach(callback: (value: string, key: string) => void): void {
    this.map.forEach((value, key) => callback(value, key));
  }
};

// Mock class-variance-authority
jest.mock("class-variance-authority", () => ({
  cva: jest.fn((base, config) => {
    return jest.fn((props) => {
      // Return a string that includes base classes and variant classes
      let classes = base ?? "";
      if (props?.variants) {
        const { variant, size, className } = props ?? {};
        // Add variant classes
        if (variant && config?.variants?.variant?.[variant]) {
          classes += " " + config.variants.variant[variant];
        }
        // Add size classes
        if (size && config?.variants?.size?.[size]) {
          classes += " " + config.variants.size[size];
        }
        // Add custom classes
        if (className) {
          classes += " " + className;
        }
      }
      return classes.trim();
    });
  }),
  type: jest.fn(),
}));

// Mock React Server Components functions
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: jest.fn((fn) => fn),
  experimental_taintUniqueValue: jest.fn(),
}));

// Mock Next.js modules
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  notFound: jest.fn(),
  redirect: jest.fn(),
}));

jest.mock("next/headers", () => ({
  headers: () => new Map(),
  cookies: () => ({
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
  }),
}));

// Mock protobuf dependencies
jest.mock("@bufbuild/protobuf", () => ({
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
  // toPlainMessage is no longer needed in v2 - responses are already plain
  fromPlainMessage: jest.fn((schema, data) => data || {}),
  create: jest.fn((schema, data) => data || {}),
}));

// Mock Connect RPC
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    getTopShorts: jest.fn(),
    getStock: jest.fn(),
    getStockData: jest.fn(),
    getStockDetails: jest.fn(),
    getIndustryTreeMap: jest.fn(),
  })),
  createPromiseClient: jest.fn(() => ({
    getTopShorts: jest.fn(),
    getStock: jest.fn(),
    getStockData: jest.fn(),
    getStockDetails: jest.fn(),
    getIndustryTreeMap: jest.fn(),
  })),
  Code: {
    Unknown: "UNKNOWN",
    InvalidArgument: "INVALID_ARGUMENT",
    NotFound: "NOT_FOUND",
  },
  ConnectError: class MockConnectError extends Error {
    code: string;
    constructor(message: string, code = "UNKNOWN") {
      super(message);
      this.code = code;
    }
  },
}));

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

// Mock NextAuth
jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    handlers: jest.fn(),
    signIn: jest.fn(),
    signOut: jest.fn(),
    auth: jest.fn(),
  })),
  getServerSession: jest.fn(),
}));

jest.mock("next-auth/providers/google", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    id: "google",
    name: "Google",
    type: "oauth",
  })),
}));

jest.mock("next-auth/providers/credentials", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    id: "credentials",
    name: "credentials",
    type: "credentials",
  })),
}));

// Mock Firebase adapter - handled via moduleNameMapper

// @/auth mock is handled via moduleNameMapper

// Mock Firebase admin
jest.mock("firebase-admin", () => ({
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
jest.mock("firebase-admin/firestore", () => ({
  __esModule: true,
  default: jest.fn(() => ({})),
  getFirestore: jest.fn(() => ({})),
}));

// Mock UI components
jest.mock("@/components/ui/button", () => ({
  __esModule: true,
  Button: jest.fn(({ children, onClick, className, ...props }) => {
    const React = require("react");
    return React.createElement(
      "button",
      {
        onClick,
        className,
        ...props,
      },
      children,
    );
  }),
  buttonVariants: jest.fn(),
}));

jest.mock("@/components/ui/card", () => {
  const React = require("react");
  const cn = (...classes: any[]) => classes.filter(Boolean).join(" ");
  return {
    __esModule: true,
    Card: React.forwardRef(({ children, className, ...props }: any, ref: any) =>
      React.createElement("div", { ref, className: cn(className), ...props }, children)
    ),
    CardHeader: React.forwardRef(({ children, className, ...props }: any, ref: any) =>
      React.createElement("div", { ref, className: cn(className), ...props }, children)
    ),
    CardTitle: React.forwardRef(({ children, className, ...props }: any, ref: any) =>
      React.createElement("h3", { ref, className: cn(className), ...props }, children)
    ),
    CardDescription: React.forwardRef(({ children, className, ...props }: any, ref: any) =>
      React.createElement("p", { ref, className: cn(className), ...props }, children)
    ),
    CardContent: React.forwardRef(({ children, className, ...props }: any, ref: any) =>
      React.createElement("div", { ref, className: cn(className), ...props }, children)
    ),
    CardFooter: React.forwardRef(({ children, className, ...props }: any, ref: any) =>
      React.createElement("div", { ref, className: cn(className), ...props }, children)
    ),
  };
});

jest.mock("@/components/ui/badge", () => {
  const React = require("react");
  return {
    __esModule: true,
    Badge: React.forwardRef(({ children, className, variant, ...props }: any, ref: any) =>
      React.createElement("span", { ref, className, ...props }, children)
    ),
  };
});

// Mock Radix UI components
jest.mock("@radix-ui/react-slot", () => ({
  Slot: ({ children, ...props }: any) => {
    const React = require("react");
    return React.createElement("div", props, children);
  },
}));

jest.mock("@radix-ui/react-select", () => {
  const React = require("react");
  const MockComponent = React.forwardRef(({ children, ...props }: any, ref: any) =>
    React.createElement("div", { ref, ...props }, children)
  );
  MockComponent.displayName = "MockSelectComponent";
  
  const ScrollUpButton = React.forwardRef(({ children, ...props }: any, ref: any) =>
    React.createElement("div", { ref, ...props }, children)
  );
  ScrollUpButton.displayName = "SelectScrollUpButton";
  
  const ScrollDownButton = React.forwardRef(({ children, ...props }: any, ref: any) =>
    React.createElement("div", { ref, ...props }, children)
  );
  ScrollDownButton.displayName = "SelectScrollDownButton";
  
  const Label = React.forwardRef(({ children, ...props }: any, ref: any) =>
    React.createElement("label", { ref, ...props }, children)
  );
  Label.displayName = "SelectLabel";
  
  const Separator = React.forwardRef(({ children, ...props }: any, ref: any) =>
    React.createElement("hr", { ref, ...props }, children)
  );
  Separator.displayName = "SelectSeparator";
  
  return {
    Root: ({ children, ...props }: any) => React.createElement("div", props, children),
    Trigger: MockComponent,
    Value: MockComponent,
    Content: MockComponent,
    Item: MockComponent,
    Label,
    Separator,
    ScrollUpButton,
    ScrollDownButton,
  };
});

jest.mock("@radix-ui/react-context", () => ({
  createContext: () => ({
    Provider: ({ children }: any) => {
      const React = require("react");
      return React.createElement(React.Fragment, {}, children);
    },
    Consumer: ({ children }: any) => {
      const React = require("react");
      return React.createElement(React.Fragment, {}, children);
    },
  }),
}));

jest.mock("@radix-ui/react-collection", () => {
  const React = require("react");
  return {
    createCollection: () => ({
      CollectionProvider: ({ children }: any) => React.createElement(React.Fragment, {}, children),
      CollectionSlot: ({ children }: any) => React.createElement(React.Fragment, {}, children),
      useCollection: () => ({ getItems: () => [] }),
    }),
    CollectionProvider: ({ children }: any) => {
      return React.createElement(React.Fragment, {}, children);
    },
  };
});

jest.mock("@radix-ui/react-toggle-group", () => {
  const React = require("react");
  const MockToggleGroup = React.forwardRef(({ children, ...props }: any, ref: any) =>
    React.createElement("div", { ref, ...props }, children)
  );
  MockToggleGroup.displayName = "ToggleGroup";
  
  const MockToggleGroupItem = React.forwardRef(({ children, ...props }: any, ref: any) =>
    React.createElement("button", { ref, ...props }, children)
  );
  MockToggleGroupItem.displayName = "ToggleGroupItem";
  
  return {
    Root: MockToggleGroup,
    Item: MockToggleGroupItem,
  };
});

jest.mock("lucide-react", () => {
  const React = require("react");
  return {
    AlertCircle: jest.fn(({ className }: any) => {
      return React.createElement("div", {
        className: `alert-circle ${className}`,
      });
    }),
    RefreshCw: jest.fn(({ className }: any) => {
      return React.createElement("div", { className: `refresh-cw ${className}` });
    }),
    Plus: jest.fn(({ className }: any) => {
      return React.createElement("div", { className: `plus ${className}` });
    }),
    X: jest.fn(({ className }: any) => {
      return React.createElement("div", { className: `x ${className}` });
    }),
    ChevronRight: jest.fn(({ className }: any) => {
      return React.createElement("div", { className: `chevron-right ${className}` });
    }),
    Home: jest.fn(({ className }: any) => {
      return React.createElement("div", { className: `home ${className}` });
    }),
    TrendingDown: jest.fn(({ className }: any) => {
      return React.createElement("div", { className: `trending-down ${className}` });
    }),
    CandlestickChart: jest.fn(({ className }: any) => {
      return React.createElement("div", { className: `candlestick-chart ${className}` });
    }),
    Users: jest.fn(({ className }: any) => {
      return React.createElement("div", { className: `users ${className}` });
    }),
    Building2: jest.fn(({ className }: any) => {
      return React.createElement("div", { className: `building2 ${className}` });
    }),
    TrendingUp: jest.fn(({ className }: any) => {
      return React.createElement("div", { className: `trending-up ${className}` });
    }),
    AlertTriangle: jest.fn(({ className }: any) => {
      return React.createElement("div", { className: `alert-triangle ${className}` });
    }),
    Newspaper: jest.fn(({ className }: any) => {
      return React.createElement("div", { className: `newspaper ${className}` });
    }),
  };
});

// Mock Login Prompt Banner
jest.mock("@/components/ui/login-prompt-banner", () => ({
  __esModule: true,
  LoginPromptBanner: jest.fn(() => {
    const React = require("react");
    return React.createElement(
      "div",
      { "data-testid": "login-prompt-banner" },
      "Login Prompt",
    );
  }),
}));

// Mock utils
jest.mock("@/lib/utils", () => ({
  cn: jest.fn((...args) => args.filter(Boolean).join(" ")),
}));

// Mock d3 modules
jest.mock("d3-array", () => ({
  bisector: jest.fn(() => ({
    left: jest.fn(),
    right: jest.fn(),
  })),
  extent: jest.fn(),
  max: jest.fn(),
  min: jest.fn(),
}));

jest.mock("d3-scale", () => ({
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
jest.mock("@visx/gradient", () => ({
  LinearGradient: jest.fn(() => null),
}));

jest.mock("@visx/event", () => ({
  localPoint: jest.fn(() => ({ x: 0, y: 0 })),
}));

jest.mock("@visx/tooltip", () => ({
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

// Mock rate limiting
jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn().mockResolvedValue({
    success: true,
  }),
}));

// Mock common actions
jest.mock("~/app/actions/getStockData", () => ({
  getStockData: jest.fn().mockResolvedValue({
    productCode: "TEST",
    points: [],
    max: null,
    min: null,
  }),
}));

jest.mock("~/app/actions/getTopShorts", () => ({
  getTopShortsData: jest.fn().mockResolvedValue({
    timeSeries: [],
    offset: 0,
  }),
}));

jest.mock("~/app/actions/getStock", () => ({
  getStock: jest.fn().mockResolvedValue({
    productCode: "TEST",
    name: "Test Stock",
    totalProductInIssue: 1000000,
    reportedShortPositions: 50000,
    percentageShorted: 5.0,
  }),
}));

// Mock environment variables
process.env = {
  ...process.env,
  NEXTAUTH_SECRET: "test-secret",
  NEXTAUTH_URL: "http://localhost:3000",
  SHORTS_SERVICE_ENDPOINT: "http://localhost:8080",
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

// Mock Performance API
if (typeof global.performance === "undefined") {
  global.performance = {} as any;
}
global.performance.mark = jest.fn();
global.performance.measure = jest.fn();
global.performance.now = jest.fn(() => Date.now());
global.performance.getEntriesByType = jest.fn(() => []);
global.performance.getEntriesByName = jest.fn(() => []);

// Console error suppression for expected test warnings
const originalError = console.error;
beforeAll(() => {
  console.error = (...args: any[]) => {
    // Convert all arguments to strings for checking
    const message = args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg instanceof Error) return arg.message;
        try {
          return String(arg);
        } catch {
          return "";
        }
      })
      .join(" ");

    // Suppress expected warnings and test error outputs
    if (
      message.includes("Warning: ReactDOM.render is no longer supported") ||
      message.includes("Warning: validateDOMNesting") ||
      message.includes("cannot appear as a child of") ||
      message.includes("asChild") || // Catches various asChild prop warnings
      message.includes("Function components cannot be given refs") ||
      message.includes("Consider adding an error boundary") ||
      message.includes("The above error occurred in the") ||
      message.includes("Uncaught [Error:") ||
      message.includes("reportException") ||
      message.includes("punycode") // Suppress punycode deprecation warnings
    ) {
      return;
    }
    originalError.call(console, ...args);
  };
});

afterAll(() => {
  console.error = originalError;
});
