// GCS Storage client factory.
//
// On Vercel: uses Workload Identity Federation via the
// VERCEL_OIDC_TOKEN env automatically injected at runtime when OIDC
// federation is enabled on the project. No static service-account
// keys.
//
// Locally: falls back to Application Default Credentials (gcloud auth
// application-default login).

import { Storage } from "@google-cloud/storage";
import { ExternalAccountClient } from "google-auth-library";

let cached: Storage | null = null;

export function gcsStorage(): Storage {
  if (cached) return cached;

  const oidcToken = process.env.VERCEL_OIDC_TOKEN;
  const projectId = process.env.GCP_PROJECT_ID;
  const provider = process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER;
  const saEmail = process.env.GCP_SERVICE_ACCOUNT_EMAIL;

  if (oidcToken && projectId && provider && saEmail) {
    // Production / preview on Vercel — use WIF.
    const authClient = ExternalAccountClient.fromJSON({
      type: "external_account",
      audience: `//iam.googleapis.com/${provider}`,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:generateAccessToken`,
      subject_token_supplier: {
        getSubjectToken: () => Promise.resolve(oidcToken),
      },
    });
    if (!authClient) {
      throw new Error("Failed to construct ExternalAccountClient");
    }
    // Type cast: @google-cloud/storage bundles an older AuthClient type
    // than google-auth-library exports; the runtime shape is compatible.
    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
    cached = new Storage({ projectId, authClient: authClient as any });
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
    return cached;
  }

  // Local dev — ADC. Requires `gcloud auth application-default login`.
  cached = new Storage({ projectId });
  return cached;
}
