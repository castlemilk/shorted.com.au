/** @jest-environment node */
import {
  emailImageSignature,
  verifyEmailImageSignature,
  isBlockedHost,
} from "@/lib/email-image";

describe("emailImageSignature", () => {
  it("matches the pinned cross-language parity vector (Go signer)", () => {
    // Must equal services/news-aggregator TestEmailImageSignatureParity.
    expect(
      emailImageSignature("https://cdn.example.com/a.jpg", "120", "test-secret"),
    ).toBe(
      "f0bb9d0a5b872eb4cb0e8f0a94579d2096a43db8802bb4b5a77256ac6cfdb801",
    );
  });
});

describe("verifyEmailImageSignature", () => {
  const url = "https://cdn.example.com/a.jpg";
  const secret = "test-secret";
  const good = emailImageSignature(url, "120", secret);

  it("accepts a valid signature", () => {
    expect(verifyEmailImageSignature(url, "120", good, secret)).toBe(true);
  });
  it("rejects a tampered url", () => {
    expect(
      verifyEmailImageSignature("https://cdn.example.com/b.jpg", "120", good, secret),
    ).toBe(false);
  });
  it("rejects a tampered width", () => {
    expect(verifyEmailImageSignature(url, "400", good, secret)).toBe(false);
  });
  it("rejects an empty or absent secret/signature", () => {
    expect(verifyEmailImageSignature(url, "120", good, "")).toBe(false);
    expect(verifyEmailImageSignature(url, "120", "", secret)).toBe(false);
  });
  it("rejects a wrong-length signature without throwing", () => {
    expect(verifyEmailImageSignature(url, "120", "deadbeef", secret)).toBe(false);
  });
});

describe("isBlockedHost (SSRF defense-in-depth)", () => {
  it.each([
    "localhost",
    "foo.local",
    "svc.internal",
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.169.254",
    "0.0.0.0",
    "metadata.google.internal",
    "::1",
    "[::1]",
    "fe80::1",
    "fd00::1",
    "fc00::1",
  ])("blocks %s", (h) => {
    expect(isBlockedHost(h)).toBe(true);
  });

  it.each([
    "cdn.example.com",
    "picsum.photos",
    "storage.googleapis.com",
    "img.afr.com",
    "8.8.8.8",
    "172.15.0.1", // just outside the private 172.16/12 block
    "172.32.0.1",
  ])("allows public host %s", (h) => {
    expect(isBlockedHost(h)).toBe(false);
  });
});
