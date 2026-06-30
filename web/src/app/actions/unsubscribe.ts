import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { RegisterService } from "~/gen/register/v1/register_pb";
import { SHORTS_API_URL } from "./config";

const browserUA: Interceptor = (next) => (req) => {
  req.header.set("User-Agent", "Mozilla/5.0 (compatible; ShortedUnsubscribe/1.0)");
  return next(req);
};

// Runs server-side (route handler + server component) → use the absolute backend URL.
export async function unsubscribe(token: string): Promise<boolean> {
  const transport = createConnectTransport({ fetch, baseUrl: SHORTS_API_URL, interceptors: [browserUA] });
  const client = createClient(RegisterService, transport);
  try {
    const res = await client.unsubscribe({ token });
    return res.success;
  } catch {
    return false;
  }
}
