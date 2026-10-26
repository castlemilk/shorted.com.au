/**
 * @jest-environment node
 */
// The proxy's answer, read the way a real client reads it over a socket.
//
// route.test.ts runs the route against a fake fetch and the fake Response from
// setup.ts, and neither decodes a body. A client does: it reads Content-Encoding
// and decodes whatever arrives. So this file puts real sockets between the
// pieces. The chat service stub answers as connect-go does (or compresses
// regardless, see startChatService), the route runs in-process with Node's own
// fetch calling the stub, and the route's Response is written to a socket the way
// Next's node server writes it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import type { NextRequest } from "next/server";
import { POST } from "../route";
import { auth } from "~/server/auth";
import { getSubscriptionStatus } from "~/app/actions/subscription";
import { rateLimit } from "@/lib/rate-limit";

jest.mock("~/server/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("~/app/actions/subscription", () => ({
  getSubscriptionStatus: jest.fn(),
}));

jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn(),
}));

const mockAuth = auth as jest.MockedFunction<typeof auth>;
const mockGetSubscriptionStatus = getSubscriptionStatus as jest.MockedFunction<
  typeof getSubscriptionStatus
>;
const mockRateLimit = rateLimit as jest.MockedFunction<typeof rateLimit>;

const INTERNAL_SECRET = "server-secret";

/** The unary answers the stub sends, one per unary method the proxy allows. */
const UNARY_ANSWERS: Record<string, unknown> = {
  ListConversations: {
    conversations: [{ id: "conv-1", title: "Short positions in BHP", updatedAt: "2026-10-01T00:00:00Z" }],
  },
  GetConversationHistory: {
    messages: [
      { id: "m-1", role: "user", content: "Which ASX stocks are most shorted?" },
      { id: "m-2", role: "assistant", content: "BHP is not among them. ".repeat(40) },
    ],
  },
  DeleteConversation: {},
};

/** The headers a browser (or Node's fetch) sends. Its Accept-Encoding is the trigger. */
const BROWSER_ACCEPT_ENCODING = "gzip, deflate, br";

interface Harness {
  url: string;
  close: () => Promise<void>;
}

/** Starts a server on a free loopback port and returns its origin. */
function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<Harness> {
  const server: Server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

async function drain(req: IncomingMessage): Promise<void> {
  for await (const _chunk of req) {
    // The request body is not the subject here.
  }
}

/**
 * The chat service as the proxy meets it. "negotiated" is connect-go: a unary
 * answer is gzipped when the caller's Accept-Encoding allows it, and then sent
 * with Content-Encoding and the compressed length. "always" is a hop that
 * compresses whatever it is asked, so the proxy's own handling of an encoded
 * answer is tested without relying on the request header. A server stream carries
 * no HTTP-level encoding in either mode, its frames are compressed per envelope.
 */
type ChatServiceMode = "negotiated" | "always";

function startChatService(mode: ChatServiceMode): Promise<Harness> {
  return listen(async (req, res) => {
    await drain(req);
    if (req.headers["x-internal-secret"] !== INTERNAL_SECRET) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    const method = (req.url ?? "").split("/").pop() ?? "";
    if (method === "SendMessage") {
      res.writeHead(200, { "content-type": "application/connect+json" });
      res.end("data: frame\n\n");
      return;
    }
    const json = Buffer.from(JSON.stringify(UNARY_ANSWERS[method] ?? {}));
    const asked = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
    if (mode === "negotiated" && !asked) {
      res.writeHead(200, { "content-type": "application/json", "content-length": String(json.length) });
      res.end(json);
      return;
    }
    const gzipped = gzipSync(json);
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(gzipped.length),
    });
    res.end(gzipped);
  });
}

/**
 * Writes a route Response to a socket the way Next's node server does: the status
 * and every header the route set, then the body. Headers are written as they are,
 * so a Content-Encoding the route kept reaches the client.
 */
function serveResponse(response: Response): Promise<Harness> {
  return listen(async (_req, res) => {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    res.writeHead(response.status, headers);
    const body = response.body as unknown;
    if (typeof body === "string") {
      res.end(body);
      return;
    }
    if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        res.write(chunk);
      }
    }
    res.end();
  });
}

function requestFor(method: string): NextRequest {
  const headers = new Headers({
    "content-type": "application/json",
    "connect-protocol-version": "1",
    origin: "https://shorted.com.au",
    "accept-encoding": BROWSER_ACCEPT_ENCODING,
  });
  return {
    url: `https://shorted.com.au/chat.v1.ChatService/${method}`,
    method: "POST",
    headers,
    body: "{}",
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

/** What the probe and the chat UI do: POST, then read the body as the client sees it. */
async function clientRead(origin: string, method: string): Promise<string> {
  const res = await fetch(`${origin}/chat.v1.ChatService/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "connect-protocol-version": "1" },
    body: "{}",
  });
  return res.text();
}

describe.each<[string, ChatServiceMode]>([
  ["negotiates gzip the way connect-go does", "negotiated"],
  ["compresses an answer whether or not it was asked for one", "always"],
])("chat RPC proxy, read over a socket: the chat service %s", (_, mode) => {
  const originalEnv = process.env;
  let chatService: Harness;
  const servers: Harness[] = [];

  beforeAll(async () => {
    chatService = await startChatService(mode);
  });

  afterAll(async () => {
    await chatService.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
      CHAT_SERVICE_INTERNAL_URL: chatService.url,
    };
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
      expires: "2099-01-01T00:00:00.000Z",
    });
    mockGetSubscriptionStatus.mockResolvedValue({
      status: "active",
      tier: "premium",
      hasActiveSubscription: true,
      isPremium: true,
      canMintTokens: true,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      features: [],
      requestsPerDay: 0,
    });
    mockRateLimit.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    process.env = originalEnv;
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it.each(["ListConversations", "GetConversationHistory", "DeleteConversation"])(
    "%s: a client reads the proxied answer as the JSON the chat service sent",
    async (method) => {
      const response = await POST(requestFor(method), { params: { method } });
      expect(response.status).toBe(200);

      const served = await serveResponse(response);
      servers.push(served);

      await expect(clientRead(served.url, method)).resolves.toBe(JSON.stringify(UNARY_ANSWERS[method]));
    },
  );

  it("passes a server stream through byte for byte", async () => {
    const response = await POST(requestFor("SendMessage"), { params: { method: "SendMessage" } });
    const served = await serveResponse(response);
    servers.push(served);

    await expect(clientRead(served.url, "SendMessage")).resolves.toBe("data: frame\n\n");
  });
});
