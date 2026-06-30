import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { RegisterService } from "~/gen/register/v1/register_pb";
import { SHORTS_API_URL } from "./config";

// Runs server-side (route handler + server component) → use the absolute backend URL.
export async function unsubscribe(token: string): Promise<boolean> {
  const transport = createConnectTransport({ fetch, baseUrl: SHORTS_API_URL });
  const client = createClient(RegisterService, transport);
  try {
    const res = await client.unsubscribe({ token });
    return res.success;
  } catch {
    return false;
  }
}
