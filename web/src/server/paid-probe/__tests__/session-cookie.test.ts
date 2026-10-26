/** @jest-environment node */
import { decode, encode } from "next-auth/jwt";

import { PROBE_SESSION_MAX_AGE_SECONDS, mintProbeSessionCookie, sessionCookieName } from "../session-cookie";

// next-auth/jwt ships as ESM .js, which this jest setup cannot parse (the
// transform covers .ts and .tsx only), so the repo mocks it the same way
// middleware-auth.test.ts does. The fake keeps the one property the probe
// depends on: a token only decodes with the secret AND salt it was encoded
// with. The real Auth.js round trip was run outside jest against the same
// module (see the PR description).
jest.mock("next-auth/jwt", () => {
  const sealed = new Map<
    string,
    { payload: Record<string, unknown>; secret: string; salt: string }
  >();
  return {
    encode: jest.fn(
      async (params: {
        token: Record<string, unknown>;
        secret: string;
        salt: string;
        maxAge: number;
      }) => {
        const iat = Math.floor(Date.now() / 1000);
        const id = `jwe-${sealed.size + 1}`;
        sealed.set(id, {
          payload: { ...params.token, iat, exp: iat + params.maxAge },
          secret: params.secret,
          salt: params.salt,
        });
        return id;
      },
    ),
    decode: jest.fn(async (params: { token: string; secret: string; salt: string }) => {
      const entry = sealed.get(params.token);
      if (!entry || entry.secret !== params.secret || entry.salt !== params.salt) {
        throw new Error("decryption failed");
      }
      return entry.payload;
    }),
  };
});

const SECRET = "test-nextauth-secret-with-enough-entropy";

describe("sessionCookieName", () => {
  it("matches the name auth.ts configures, with the __Secure- prefix only in production", () => {
    expect(sessionCookieName("production")).toBe("__Secure-next-auth.session-token");
    expect(sessionCookieName("development")).toBe("next-auth.session-token");
    expect(sessionCookieName(undefined)).toBe("next-auth.session-token");
  });
});

describe("mintProbeSessionCookie", () => {
  it("encodes with the cookie name as salt and NEXTAUTH_SECRET, on the short run window", async () => {
    const cookie = await mintProbeSessionCookie({ secret: SECRET, nodeEnv: "production" });

    expect(cookie.name).toBe("__Secure-next-auth.session-token");
    expect(encode).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: SECRET,
        salt: "__Secure-next-auth.session-token",
        maxAge: PROBE_SESSION_MAX_AGE_SECONDS,
      }),
    );
  });

  it("round-trips: the cookie decodes with the same salt and carries id, sub and email", async () => {
    const cookie = await mintProbeSessionCookie({ secret: SECRET, nodeEnv: "production" });

    const payload = await decode({ token: cookie.value, secret: SECRET, salt: cookie.name });
    expect(payload).toMatchObject({
      sub: "svc-paid-probe",
      id: "svc-paid-probe",
      email: "paid-probe@shorted.com.au",
      name: "Paid feature probe",
    });
  });

  it("is not readable under a different salt or secret", async () => {
    const cookie = await mintProbeSessionCookie({ secret: SECRET, nodeEnv: "production" });

    await expect(
      decode({ token: cookie.value, secret: SECRET, salt: "next-auth.session-token" }),
    ).rejects.toThrow();
    await expect(
      decode({ token: cookie.value, secret: "another-secret", salt: cookie.name }),
    ).rejects.toThrow();
  });
});
