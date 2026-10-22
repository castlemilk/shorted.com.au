// Every operation an OpenAPI 3 Path Item can hold (parser.ts OPERATION_METHODS).
export type HTTPMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'PATCH'
  | 'HEAD'
  | 'OPTIONS'
  | 'TRACE';

export interface Parameter {
  name: string;
  in: 'header' | 'query' | 'path' | 'cookie';
  required?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  description?: string;
}

export interface RequestBody {
  description?: string;
  content: Record<string, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: any;
  }>;
  required?: boolean;
}

export interface Response {
  description: string;
  content?: Record<string, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: any;
  }>;
}

export interface ParsedEndpoint {
  id: string; // generated slug
  method: HTTPMethod;
  path: string;
  summary?: string;
  description?: string;
  operationId?: string;
  tags: string[];
  parameters: Parameter[];
  requestBody?: RequestBody;
  responses: Record<string, Response>;
  /**
   * Servers the operation or its path declares, which replace the document's
   * (OpenAPI 3: operation, then path, then document). /api/search/stocks and
   * /feed.xml are served by the web app, not the API host. Absent when the
   * endpoint uses the document's servers.
   */
  servers?: Server[];
}

export interface NavigationGroup {
  tag: string;
  title: string;
  endpoints: ParsedEndpoint[];
}

export interface Server {
  url: string;
  description?: string;
}

export interface OpenAPISpec {
  info: {
    title: string;
    description?: string;
    version: string;
  };
  /** `servers` from the generated document. `servers[0].url` is the public API host. */
  servers: Server[];
  endpoints: ParsedEndpoint[];
  groups: NavigationGroup[];
  components: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schemas: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    securitySchemes?: Record<string, any>;
  };
}



