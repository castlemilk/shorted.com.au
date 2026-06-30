import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { RegisterService } from "~/gen/register/v1/register_pb";

// NOTE: this runs in the BROWSER (imported by the "use client" RegisterEmail
// component). Use a relative baseUrl ("") so the request is same-origin and
// flows through the Next.js rewrite proxy (next.config.mjs:
// `/register.v1.RegisterService/:path*` -> backend) instead of hitting the
// Cloud Run backend cross-origin (no CORS grant → blocked).
// Do NOT wrap this in react cache() — it's a mutation, not an idempotent read.
export async function registerEmail(email: string) {
  const transport = createConnectTransport({
    fetch,
    baseUrl: "",
  });

  const client = createClient(RegisterService, transport);
  return client.registerEmail({ email });
}
