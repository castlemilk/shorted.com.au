# Shorted API Client SDKs

Official client libraries for the Shorted API. All SDKs are generated from our protobuf definitions using [Buf](https://buf.build/).

## Go

The Go SDK provides type-safe access via Connect-RPC.

### Installation

```bash
go get github.com/castlemilk/shorted/sdks/go
```

### Usage

```go
package main

import (
	"context"
	"fmt"
	"net/http"

	"connectrpc.com/connect"
	shortsv1 "github.com/castlemilk/shorted/sdks/go/shortedapi/shorts/v1alpha1"
	"github.com/castlemilk/shorted/sdks/go/shortedapi/shorts/v1alpha1/shortsv1connect"
)

func main() {
	client := shortsv1connect.NewShortedStocksServiceClient(
		http.DefaultClient,
		"https://api.shorted.com.au",
	)

	resp, err := client.GetTopShorts(context.Background(), connect.NewRequest(&shortsv1.GetTopShortsRequest{
		Period: "3m",
		Limit:  10,
	}))
	if err != nil {
		panic(err)
	}

	for _, ts := range resp.Msg.TimeSeries {
		fmt.Printf("%s: %.2f%%\n", ts.ProductCode, ts.LatestShortPosition)
	}
}
```

### Authentication

```go
// Add Bearer token for authenticated endpoints
req := connect.NewRequest(&shortsv1.GetStockDataRequest{
	ProductCode: "CBA",
	Period:      "6m",
})
req.Header().Set("Authorization", "Bearer YOUR_API_KEY")

resp, err := client.GetStockData(context.Background(), req)
```

---

## TypeScript

The TypeScript SDK uses Connect-ES for browser and Node.js environments.

### Installation

```bash
npm install @shorted/sdk
```

### Usage

```typescript
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { ShortedStocksService } from "@shorted/sdk";

const transport = createConnectTransport({
  baseUrl: "https://api.shorted.com.au",
});

const client = createClient(ShortedStocksService, transport);

const topShorts = await client.getTopShorts({
  period: "3m",
  limit: 10,
});

for (const ts of topShorts.timeSeries) {
  console.log(`${ts.productCode}: ${ts.latestShortPosition}%`);
}
```

### Authentication

```typescript
const transport = createConnectTransport({
  baseUrl: "https://api.shorted.com.au",
  interceptors: [
    (next) => async (req) => {
      req.header.set("Authorization", "Bearer YOUR_API_KEY");
      return next(req);
    },
  ],
});
```

---

## Java

The Java SDK provides protobuf-generated types for JVM applications.

### Maven

```xml
<dependency>
  <groupId>au.com.shorted</groupId>
  <artifactId>shorted-sdk</artifactId>
  <version>1.0.0</version>
</dependency>
```

### Gradle

```groovy
implementation 'au.com.shorted:shorted-sdk:1.0.0'
```

### Usage

```java
import java.net.*;
import java.io.*;

public class ShortedExample {
    public static void main(String[] args) throws Exception {
        URL url = new URL("https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetTopShorts");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Authorization", "Bearer YOUR_API_KEY");
        conn.setDoOutput(true);

        String json = "{\"period\":\"3m\",\"limit\":10}";
        conn.getOutputStream().write(json.getBytes());

        BufferedReader reader = new BufferedReader(
            new InputStreamReader(conn.getInputStream()));
        String line;
        while ((line = reader.readLine()) != null) {
            System.out.println(line);
        }
    }
}
```

---

## API Base URLs

| Environment | URL |
|-------------|-----|
| Production  | `https://api.shorted.com.au` |
| Development | `http://localhost:9091` |

## Generating from Source

All SDKs are generated from protobuf definitions:

```bash
cd proto
buf generate
```

This generates code into:
- `sdks/go/` — Go types + Connect-RPC
- `sdks/typescript/` — TypeScript types + Connect-ES
- `sdks/java/src/main/java/` — Java protobuf types
