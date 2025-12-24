export type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

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
}

export interface NavigationGroup {
  tag: string;
  title: string;
  endpoints: ParsedEndpoint[];
}

export interface OpenAPISpec {
  info: {
    title: string;
    description?: string;
    version: string;
  };
  endpoints: ParsedEndpoint[];
  groups: NavigationGroup[];
  components: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schemas: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    securitySchemes?: Record<string, any>;
  };
}



