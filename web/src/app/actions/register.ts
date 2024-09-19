import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { toPlainMessage } from "@bufbuild/protobuf";
import { RegisterService } from "~/gen/register/v1/register_connect";
import { cache } from "react";
export const registerEmail = cache(async (email: string) => {
  const transport = createConnectTransport({
    fetch,
    baseUrl:
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
      "http://localhost:8080",
  });

  const client = createPromiseClient(RegisterService, transport);
  const response = await client.registerEmail({ email });

  return toPlainMessage(response);
});
