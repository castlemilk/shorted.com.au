import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { RegisterService } from "~/gen/register/v1/register_pb";
import { cache } from "react";
import { SHORTS_API_URL } from "./config";

export const registerEmail = cache(async (email: string) => {
  const transport = createConnectTransport({
    fetch,
    baseUrl:
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
      SHORTS_API_URL,
  });

  const client = createClient(RegisterService, transport);
  const response = await client.registerEmail({ email });

  return response;
});
