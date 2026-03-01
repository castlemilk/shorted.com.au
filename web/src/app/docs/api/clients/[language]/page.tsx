import React from 'react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';

const BASE_URL = 'https://shorts-uiekqxovma-km.a.run.app';

interface ClientGuide {
  name: string;
  description: string;
  prerequisites: string[];
  authExample: string;
  getTopShortsExample: string;
  getStockExample: string;
  errorHandlingExample: string;
}

const CLIENT_GUIDES: Record<string, ClientGuide> = {
  curl: {
    name: 'cURL',
    description: 'cURL is a command-line tool for making HTTP requests. It comes pre-installed on macOS and most Linux distributions.',
    prerequisites: ['cURL installed (pre-installed on macOS/Linux)', 'A terminal or shell'],
    authExample: `# Authenticated request with Bearer token
curl -X POST "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{"limit": 10}'`,
    getTopShortsExample: `curl -X POST "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts" \\
  -H "Content-Type: application/json" \\
  -d '{
    "limit": 10,
    "offset": 0
  }'`,
    getStockExample: `curl -X POST "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetStock" \\
  -H "Content-Type: application/json" \\
  -d '{
    "productCode": "BHP"
  }'`,
    errorHandlingExample: `# Check HTTP status code
response=$(curl -s -w "\\n%{http_code}" -X POST \\
  "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts" \\
  -H "Content-Type: application/json" \\
  -d '{"limit": 10}')

http_code=$(echo "$response" | tail -1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" -eq 429 ]; then
  echo "Rate limited. Check Retry-After header."
elif [ "$http_code" -ne 200 ]; then
  echo "Error $http_code: $body"
else
  echo "$body" | jq .
fi`,
  },
  javascript: {
    name: 'JavaScript',
    description: 'Use the built-in fetch API available in modern browsers and Node.js 18+ to call the Shorted API. No additional dependencies required.',
    prerequisites: ['Node.js 18+ (for server-side) or any modern browser', 'No additional packages needed'],
    authExample: `const response = await fetch(
  "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_API_KEY",
    },
    body: JSON.stringify({ limit: 10 }),
  }
);

const data = await response.json();`,
    getTopShortsExample: `const response = await fetch(
  "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 10, offset: 0 }),
  }
);

const { stocks, totalCount } = await response.json();
console.log(\`Top \${stocks.length} of \${totalCount} shorted stocks:\`);
stocks.forEach((stock) => {
  console.log(\`\${stock.productCode}: \${stock.currentPercent}%\`);
});`,
    getStockExample: `const response = await fetch(
  "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetStock",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productCode: "BHP" }),
  }
);

const { stock } = await response.json();
console.log(stock.companyName, stock.currentPercent + "%");`,
    errorHandlingExample: `async function apiCall(path, body) {
  const response = await fetch(\`${BASE_URL}\${path}\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_API_KEY",
    },
    body: JSON.stringify(body),
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    throw new Error(\`Rate limited. Retry after \${retryAfter}s\`);
  }

  if (!response.ok) {
    const error = await response.json();
    throw new Error(\`API error \${response.status}: \${error.message}\`);
  }

  return response.json();
}`,
  },
  python: {
    name: 'Python',
    description: 'Use the popular requests library to interact with the Shorted API. It provides a simple, human-friendly interface for HTTP.',
    prerequisites: ['Python 3.8+', '`pip install requests`'],
    authExample: `import requests

url = "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts"
headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer YOUR_API_KEY",
}

response = requests.post(url, json={"limit": 10}, headers=headers)
data = response.json()`,
    getTopShortsExample: `import requests

url = "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts"
response = requests.post(url, json={"limit": 10, "offset": 0})
data = response.json()

for stock in data["stocks"]:
    print(f"{stock['productCode']}: {stock['currentPercent']}%")`,
    getStockExample: `import requests

url = "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetStock"
response = requests.post(url, json={"productCode": "BHP"})
stock = response.json()["stock"]

print(f"{stock['companyName']} ({stock['productCode']})")
print(f"Short position: {stock['currentPercent']}%")
print(f"Industry: {stock['industry']}")`,
    errorHandlingExample: `import requests
import time

def api_call(path, body, api_key=None):
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    response = requests.post(
        f"${BASE_URL}{path}",
        json=body,
        headers=headers,
    )

    if response.status_code == 429:
        retry_after = int(response.headers.get("Retry-After", 60))
        print(f"Rate limited. Retrying in {retry_after}s...")
        time.sleep(retry_after)
        return api_call(path, body, api_key)

    response.raise_for_status()
    return response.json()

# Usage
data = api_call(
    "/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
    {"limit": 10},
    api_key="YOUR_API_KEY",
)`,
  },
  typescript: {
    name: 'TypeScript',
    description: 'Use fetch with TypeScript interfaces for type-safe API calls. Define response types to get autocomplete and compile-time checks.',
    prerequisites: ['TypeScript 5.0+', 'Node.js 18+ or modern browser'],
    authExample: `interface ApiOptions {
  apiKey?: string;
}

async function shortedApi<T>(
  path: string,
  body: Record<string, unknown>,
  options?: ApiOptions
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options?.apiKey) {
    headers["Authorization"] = \`Bearer \${options.apiKey}\`;
  }

  const response = await fetch(\`${BASE_URL}\${path}\`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(\`API error: \${response.status}\`);
  }

  return response.json() as Promise<T>;
}`,
    getTopShortsExample: `interface ShortPosition {
  productCode: string;
  productName: string;
  currentPercent: number;
  previousPercent: number;
  industry: string;
  companyName: string;
}

interface GetTopShortsResponse {
  stocks: ShortPosition[];
  totalCount: number;
}

const response = await fetch(
  "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 10, offset: 0 }),
  }
);

const data: GetTopShortsResponse = await response.json();
data.stocks.forEach((stock) => {
  console.log(\`\${stock.productCode}: \${stock.currentPercent}%\`);
});`,
    getStockExample: `interface Stock {
  productCode: string;
  companyName: string;
  currentPercent: number;
  industry: string;
  description: string;
}

interface GetStockResponse {
  stock: Stock;
}

const response = await fetch(
  "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetStock",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productCode: "BHP" }),
  }
);

const { stock }: GetStockResponse = await response.json();
console.log(\`\${stock.companyName}: \${stock.currentPercent}%\`);`,
    errorHandlingExample: `interface ApiError {
  code: string;
  message: string;
}

async function safeApiCall<T>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(\`${BASE_URL}\${path}\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_API_KEY",
    },
    body: JSON.stringify(body),
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After") ?? "60";
    throw new Error(\`Rate limited. Retry after \${retryAfter}s\`);
  }

  if (!response.ok) {
    const error: ApiError = await response.json();
    throw new Error(\`\${error.code}: \${error.message}\`);
  }

  return response.json() as Promise<T>;
}`,
  },
  go: {
    name: 'Go',
    description: 'Use the standard library net/http package to call the Shorted API. No external dependencies are required.',
    prerequisites: ['Go 1.21+', 'No external dependencies needed'],
    authExample: `package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
)

func main() {
	body := bytes.NewBufferString(\`{"limit": 10}\`)
	req, _ := http.NewRequest("POST",
		"${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer YOUR_API_KEY")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(resp.Body)
	fmt.Println(string(data))
}`,
    getTopShortsExample: `package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

type ShortPosition struct {
	ProductCode    string  \`json:"productCode"\`
	ProductName    string  \`json:"productName"\`
	CurrentPercent float64 \`json:"currentPercent"\`
	Industry       string  \`json:"industry"\`
	CompanyName    string  \`json:"companyName"\`
}

type TopShortsResponse struct {
	Stocks     []ShortPosition \`json:"stocks"\`
	TotalCount int             \`json:"totalCount"\`
}

func main() {
	body := bytes.NewBufferString(\`{"limit": 10, "offset": 0}\`)
	resp, err := http.Post(
		"${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
		"application/json", body)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()

	var result TopShortsResponse
	json.NewDecoder(resp.Body).Decode(&result)

	for _, s := range result.Stocks {
		fmt.Printf("%s: %.2f%%\\n", s.ProductCode, s.CurrentPercent)
	}
}`,
    getStockExample: `package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

type Stock struct {
	ProductCode    string  \`json:"productCode"\`
	CompanyName    string  \`json:"companyName"\`
	CurrentPercent float64 \`json:"currentPercent"\`
	Industry       string  \`json:"industry"\`
}

type GetStockResponse struct {
	Stock Stock \`json:"stock"\`
}

func main() {
	body := bytes.NewBufferString(\`{"productCode": "BHP"}\`)
	resp, err := http.Post(
		"${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetStock",
		"application/json", body)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()

	var result GetStockResponse
	json.NewDecoder(resp.Body).Decode(&result)

	fmt.Printf("%s (%s): %.2f%%\\n",
		result.Stock.CompanyName, result.Stock.ProductCode, result.Stock.CurrentPercent)
}`,
    errorHandlingExample: `package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

func apiCall(path string, body []byte, apiKey string) ([]byte, error) {
	req, err := http.NewRequest("POST", "${BASE_URL}"+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusTooManyRequests {
		retryAfter, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
		if retryAfter == 0 {
			retryAfter = 60
		}
		fmt.Printf("Rate limited. Retrying in %ds...\\n", retryAfter)
		time.Sleep(time.Duration(retryAfter) * time.Second)
		return apiCall(path, body, apiKey)
	}

	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(data))
	}

	return io.ReadAll(resp.Body)
}

func main() {
	data, err := apiCall(
		"/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
		[]byte(\`{"limit": 10}\`),
		"YOUR_API_KEY",
	)
	if err != nil {
		panic(err)
	}

	var result map[string]interface{}
	json.Unmarshal(data, &result)
	fmt.Println(result)
}`,
  },
  java: {
    name: 'Java',
    description: 'Use the built-in java.net.HttpURLConnection to call the Shorted API. No external libraries are required for basic usage.',
    prerequisites: ['Java 11+', 'No external dependencies for basic HTTP'],
    authExample: `import java.net.*;
import java.io.*;

public class ShortedApiAuth {
    public static void main(String[] args) throws Exception {
        URL url = new URL(
            "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Authorization", "Bearer YOUR_API_KEY");
        conn.setDoOutput(true);

        String json = "{\\"limit\\": 10}";
        conn.getOutputStream().write(json.getBytes());

        BufferedReader reader = new BufferedReader(
            new InputStreamReader(conn.getInputStream()));
        String line;
        while ((line = reader.readLine()) != null) {
            System.out.println(line);
        }
    }
}`,
    getTopShortsExample: `import java.net.*;
import java.io.*;

public class GetTopShorts {
    public static void main(String[] args) throws Exception {
        URL url = new URL(
            "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setDoOutput(true);

        String json = "{\\"limit\\": 10, \\"offset\\": 0}";
        conn.getOutputStream().write(json.getBytes());

        BufferedReader reader = new BufferedReader(
            new InputStreamReader(conn.getInputStream()));
        StringBuilder response = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            response.append(line);
        }

        System.out.println(response.toString());
    }
}`,
    getStockExample: `import java.net.*;
import java.io.*;

public class GetStock {
    public static void main(String[] args) throws Exception {
        URL url = new URL(
            "${BASE_URL}/shorts.v1alpha1.ShortedStocksService/GetStock");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setDoOutput(true);

        String json = "{\\"productCode\\": \\"BHP\\"}";
        conn.getOutputStream().write(json.getBytes());

        BufferedReader reader = new BufferedReader(
            new InputStreamReader(conn.getInputStream()));
        StringBuilder response = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            response.append(line);
        }

        System.out.println(response.toString());
    }
}`,
    errorHandlingExample: `import java.net.*;
import java.io.*;

public class ShortedApiClient {
    private static final String BASE_URL = "${BASE_URL}";

    public static String apiCall(String path, String body, String apiKey)
            throws Exception {
        URL url = new URL(BASE_URL + path);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        if (apiKey != null) {
            conn.setRequestProperty("Authorization", "Bearer " + apiKey);
        }
        conn.setDoOutput(true);
        conn.getOutputStream().write(body.getBytes());

        int status = conn.getResponseCode();

        if (status == 429) {
            String retryAfter = conn.getHeaderField("Retry-After");
            int delay = retryAfter != null ? Integer.parseInt(retryAfter) : 60;
            System.out.printf("Rate limited. Retrying in %ds...%n", delay);
            Thread.sleep(delay * 1000L);
            return apiCall(path, body, apiKey);
        }

        InputStream stream = status >= 400
            ? conn.getErrorStream()
            : conn.getInputStream();

        BufferedReader reader = new BufferedReader(new InputStreamReader(stream));
        StringBuilder response = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            response.append(line);
        }

        if (status >= 400) {
            throw new RuntimeException(
                "API error " + status + ": " + response);
        }

        return response.toString();
    }

    public static void main(String[] args) throws Exception {
        String result = apiCall(
            "/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
            "{\\"limit\\": 10}",
            "YOUR_API_KEY"
        );
        System.out.println(result);
    }
}`,
  },
};

const SUPPORTED_LANGUAGES = Object.keys(CLIENT_GUIDES);

export async function generateStaticParams() {
  return SUPPORTED_LANGUAGES.map((language) => ({ language }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ language: string }>;
}): Promise<Metadata> {
  const { language } = await params;
  const guide = CLIENT_GUIDES[language];
  if (!guide) return {};

  return {
    title: `${guide.name} Client Guide | Shorted API`,
    description: `How to use the Shorted API with ${guide.name}. Includes authentication, code examples, and error handling.`,
  };
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  return (
    <div className="relative">
      <pre className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 overflow-x-auto">
        <code className={`text-sm text-zinc-300 language-${language}`}>
          {code}
        </code>
      </pre>
    </div>
  );
}

function langForHighlight(slug: string): string {
  switch (slug) {
    case 'curl': return 'bash';
    case 'javascript': return 'javascript';
    case 'python': return 'python';
    case 'typescript': return 'typescript';
    case 'go': return 'go';
    case 'java': return 'java';
    default: return 'text';
  }
}

export default async function ClientGuidePage({
  params,
}: {
  params: Promise<{ language: string }>;
}) {
  const { language } = await params;
  const guide = CLIENT_GUIDES[language];

  if (!guide) {
    notFound();
  }

  const lang = langForHighlight(language);

  return (
    <div className="container max-w-4xl py-10 space-y-12">
      <div className="space-y-4">
        <Link
          href="/docs/api#client-guides"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to API docs
        </Link>
        <h1 className="text-4xl font-extrabold tracking-tight">
          {guide.name} Client Guide
        </h1>
        <p className="text-xl text-muted-foreground">{guide.description}</p>
      </div>

      <section className="space-y-4">
        <h2 className="text-2xl font-bold tracking-tight">Prerequisites</h2>
        <ul className="list-disc list-inside text-muted-foreground space-y-1">
          {guide.prerequisites.map((prereq, i) => (
            <li key={i}>{prereq}</li>
          ))}
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-bold tracking-tight">Authentication</h2>
        <p className="text-muted-foreground">
          Include your API key in the <code className="text-xs bg-muted px-1 py-0.5 rounded">Authorization</code> header
          as a Bearer token. Public endpoints work without authentication but have lower rate limits.
        </p>
        <CodeBlock code={guide.authExample} language={lang} />
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-bold tracking-tight">
          Example: Get Top Shorted Stocks
        </h2>
        <p className="text-muted-foreground">
          Retrieve the most heavily shorted stocks on the ASX, sorted by short
          interest percentage.
        </p>
        <CodeBlock code={guide.getTopShortsExample} language={lang} />
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-bold tracking-tight">
          Example: Get Stock Details
        </h2>
        <p className="text-muted-foreground">
          Fetch detailed information about a specific stock by its ASX code.
        </p>
        <CodeBlock code={guide.getStockExample} language={lang} />
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-bold tracking-tight">Error Handling</h2>
        <p className="text-muted-foreground">
          The API returns standard HTTP status codes. Rate limited requests return{' '}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">429</code> with
          a <code className="text-xs bg-muted px-1 py-0.5 rounded">Retry-After</code> header.
          Always check the response status before parsing the body.
        </p>
        <CodeBlock code={guide.errorHandlingExample} language={lang} />
      </section>

      <section className="space-y-4 border-t pt-8">
        <h2 className="text-2xl font-bold tracking-tight">All Endpoints</h2>
        <p className="text-muted-foreground">
          See the{' '}
          <Link href="/docs/api" className="text-blue-500 hover:underline">
            full API reference
          </Link>{' '}
          for all available endpoints, request/response schemas, and the interactive
          &quot;Try It&quot; panel.
        </p>
      </section>
    </div>
  );
}
