/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import type { ParsedEndpoint } from './types';

export function generateCurl(endpoint: ParsedEndpoint, baseUrl: string): string {
  let curl = `curl -X ${endpoint.method} "${baseUrl}${endpoint.path}"`;

  // Add headers
  curl += ` \\\n  -H "Content-Type: application/json"`;

  // Add parameters (simplified)
  // In a real app, we'd iterate through parameters and add them as -H or in URL

  // Add request body example if exists
  if (endpoint.requestBody?.content?.['application/json']?.schema) {
    const example = generateExampleFromJsonSchema(endpoint.requestBody.content['application/json'].schema);
    curl += ` \\\n  -d '${JSON.stringify(example, null, 2)}'`;
  }

  return curl;
}

export function generateJavascript(endpoint: ParsedEndpoint, baseUrl: string): string {
  const options: any = {
    method: endpoint.method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (endpoint.requestBody?.content?.['application/json']?.schema) {
    options.body = 'JSON.stringify(data)';
  }

  return `const response = await fetch("${baseUrl}${endpoint.path}", ${JSON.stringify(options, null, 2).replace('"JSON.stringify(data)"', 'JSON.stringify(data)')});
const data = await response.json();`;
}

export function generatePython(endpoint: ParsedEndpoint, baseUrl: string): string {
  let python = `import requests\n\nurl = "${baseUrl}${endpoint.path}"\n`;
  
  if (endpoint.requestBody?.content?.['application/json']?.schema) {
    python += `data = ${JSON.stringify(generateExampleFromJsonSchema(endpoint.requestBody.content['application/json'].schema), null, 4)}\n`;
    python += `response = requests.${endpoint.method.toLowerCase()}(url, json=data)\n`;
  } else {
    python += `response = requests.${endpoint.method.toLowerCase()}(url)\n`;
  }
  
  python += `print(response.json())`;
  return python;
}

export function generateTypescript(endpoint: ParsedEndpoint, baseUrl: string): string {
  // This could be more elaborate, using generated types
  return `import { createPromiseClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

const transport = createConnectTransport({
  baseUrl: "${baseUrl}",
});

// Implementation details would go here based on Connect RPC patterns
`;
}

export function generateGo(endpoint: ParsedEndpoint, baseUrl: string): string {
  let body = '';
  if (endpoint.requestBody?.content?.['application/json']?.schema) {
    const example = generateExampleFromJsonSchema(endpoint.requestBody.content['application/json'].schema);
    body = `\tbody := bytes.NewBuffer([]byte(\`${JSON.stringify(example, null, 2)}\`))\n`;
  }

  return `package main

import (
\t"bytes"
\t"fmt"
\t"io"
\t"net/http"
)

func main() {
${body}\treq, _ := http.NewRequest("${endpoint.method}", "${baseUrl}${endpoint.path}", ${body ? 'body' : 'nil'})
\treq.Header.Set("Content-Type", "application/json")
\treq.Header.Set("Authorization", "Bearer YOUR_API_KEY")

\tresp, err := http.DefaultClient.Do(req)
\tif err != nil {
\t\tpanic(err)
\t}
\tdefer resp.Body.Close()

\tdata, _ := io.ReadAll(resp.Body)
\tfmt.Println(string(data))
}`;
}

export function generateJava(endpoint: ParsedEndpoint, baseUrl: string): string {
  let body = '';
  if (endpoint.requestBody?.content?.['application/json']?.schema) {
    const example = generateExampleFromJsonSchema(endpoint.requestBody.content['application/json'].schema);
    body = `\t\tString json = "${JSON.stringify(example).replace(/"/g, '\\"')}";\n\t\tconnection.setDoOutput(true);\n\t\tconnection.getOutputStream().write(json.getBytes());\n`;
  }

  return `import java.net.*;
import java.io.*;

public class ShortedApiExample {
\tpublic static void main(String[] args) throws Exception {
\t\tURL url = new URL("${baseUrl}${endpoint.path}");
\t\tHttpURLConnection connection = (HttpURLConnection) url.openConnection();
\t\tconnection.setRequestMethod("${endpoint.method}");
\t\tconnection.setRequestProperty("Content-Type", "application/json");
\t\tconnection.setRequestProperty("Authorization", "Bearer YOUR_API_KEY");
${body}
\t\tBufferedReader reader = new BufferedReader(
\t\t\tnew InputStreamReader(connection.getInputStream()));
\t\tString line;
\t\twhile ((line = reader.readLine()) != null) {
\t\t\tSystem.out.println(line);
\t\t}
\t}
}`;
}

export function generateExampleFromJsonSchema(schema: any): any {
  if (schema.example) return schema.example;
  if (schema.default) return schema.default;

  if (schema.type === 'object') {
    const obj: any = {};
    if (schema.properties) {
      Object.keys(schema.properties).forEach((key) => {
        obj[key] = generateExampleFromJsonSchema(schema.properties[key]);
      });
    }
    return obj;
  }

  if (schema.type === 'array') {
    return [generateExampleFromJsonSchema(schema.items)];
  }

  switch (schema.type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return true;
    default:
      return null;
  }
}



