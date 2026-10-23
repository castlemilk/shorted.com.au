import {
  chatErrorCopy,
  formatWait,
  parseChatError,
  secondsUntilReset,
} from "../chat-errors";

const NOW_MS = Date.UTC(2026, 9, 23, 12, 0, 0);

function contractError(body: Record<string, unknown>): Error {
  return new Error(JSON.stringify(body));
}

describe("parseChatError: API contract", () => {
  it.each([
    ["unauthenticated"],
    ["premium_required"],
    ["invalid_request"],
    ["unavailable"],
  ])("reads the %s code from an Error message", (code) => {
    expect(
      parseChatError(
        contractError({ error: "x", code, message: "Human text." }),
      ),
    ).toEqual({ code, message: "Human text." });
  });

  it("reads rate limits with their window and reset fields", () => {
    expect(
      parseChatError(
        contractError({
          error: "rate limited",
          code: "rate_limited",
          message: "Too many messages.",
          retryAfterSeconds: 42,
          limitKind: "per_minute",
          resetAt: 1_761_220_000,
        }),
      ),
    ).toEqual({
      code: "rate_limited",
      message: "Too many messages.",
      retryAfterSeconds: 42,
      limitKind: "per_minute",
      resetAt: 1_761_220_000,
    });
  });

  it("reads the contract from an in-stream errorText", () => {
    expect(
      parseChatError({
        errorText: JSON.stringify({
          error: "x",
          code: "unavailable",
          message: "Down.",
        }),
      }),
    ).toEqual({ code: "unavailable", message: "Down." });
  });

  it("drops fields the contract types do not allow", () => {
    const info = parseChatError(
      contractError({
        code: "rate_limited",
        retryAfterSeconds: "42",
        limitKind: "weekly",
        resetAt: -5,
      }),
    );
    expect(info).toEqual({ code: "rate_limited", message: "" });
  });

  it("drops a negative retryAfterSeconds but keeps zero", () => {
    expect(
      parseChatError(contractError({ code: "rate_limited", retryAfterSeconds: -1 }))
        .retryAfterSeconds,
    ).toBeUndefined();
    expect(
      parseChatError(contractError({ code: "rate_limited", retryAfterSeconds: 0 }))
        .retryAfterSeconds,
    ).toBe(0);
  });

  it("never treats a JSON or markup message as a sentence", () => {
    expect(
      parseChatError(
        contractError({ code: "invalid_request", message: '{"nested":true}' }),
      ).message,
    ).toBe("");
    expect(
      parseChatError(
        contractError({ code: "invalid_request", message: "<b>bold</b>" }),
      ).message,
    ).toBe("");
  });

  it("truncates an overlong server message", () => {
    const long = "a".repeat(500);
    const { message } = parseChatError(
      contractError({ code: "invalid_request", message: long }),
    );
    expect(message.length).toBeLessThanOrEqual(300);
    expect(message.endsWith("…")).toBe(true);
  });

  it("trusts the known code over the legacy error text", () => {
    expect(
      parseChatError(
        contractError({ error: "Rate limit exceeded", code: "invalid_request", message: "Bad." }),
      ).code,
    ).toBe("invalid_request");
  });

  it("classifies an unknown code by its text", () => {
    expect(
      parseChatError(contractError({ code: "teapot", error: "Rate limit exceeded" }))
        .code,
    ).toBe("rate_limited");
  });
});

describe("parseChatError: legacy and foreign bodies", () => {
  it.each([
    ["Rate limit exceeded", "rate_limited"],
    ["Too many requests", "rate_limited"],
    ["Unauthorized", "unauthenticated"],
    ["Please sign in first", "unauthenticated"],
    ["Premium subscription required", "premium_required"],
    ["Invalid chat request", "invalid_request"],
    ["A user message is required", "invalid_request"],
    ["Chat is temporarily unavailable.", "unavailable"],
  ])("maps the legacy error %j to %s", (legacy, code) => {
    expect(parseChatError(contractError({ error: legacy })).code).toBe(code);
  });

  it("keeps a legacy sentence that is safe to show", () => {
    expect(
      parseChatError(contractError({ error: "A user message is required" })),
    ).toEqual({ code: "invalid_request", message: "A user message is required" });
  });

  it("returns unavailable with no message for a non-JSON string", () => {
    expect(parseChatError(new Error("Failed to fetch"))).toEqual({
      code: "unavailable",
      message: "",
    });
  });

  it("maps a plain rate-limit string without showing it", () => {
    expect(parseChatError("429 Too Many Requests")).toEqual({
      code: "rate_limited",
      message: "",
    });
  });

  it("treats an HTML error page as unavailable and shows none of it", () => {
    const html = "<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>";
    expect(parseChatError(new Error(html))).toEqual({
      code: "unavailable",
      message: "",
    });
    expect(parseChatError(new Error("<html>premium</html>")).code).toBe(
      "unavailable",
    );
  });

  it("treats a JSON array or scalar as unavailable", () => {
    expect(parseChatError(new Error("[1,2,3]")).code).toBe("unavailable");
    expect(parseChatError(new Error("42")).code).toBe("unavailable");
  });

  it("treats malformed JSON as unavailable", () => {
    expect(parseChatError(new Error('{"code": "rate_limited"')).code).toBe(
      "unavailable",
    );
  });

  it.each([[undefined], [null], [""], [42], [{}]])(
    "returns unavailable for %p",
    (value) => {
      expect(parseChatError(value)).toEqual({ code: "unavailable", message: "" });
    },
  );

  it("reads a bare string", () => {
    expect(parseChatError("Chat is busy")).toEqual({
      code: "unavailable",
      message: "",
    });
  });
});

describe("secondsUntilReset", () => {
  it("prefers resetAt over retryAfterSeconds", () => {
    expect(
      secondsUntilReset(
        { code: "rate_limited", message: "", resetAt: NOW_MS / 1000 + 90, retryAfterSeconds: 5 },
        NOW_MS,
      ),
    ).toBe(90);
  });

  it("falls back to retryAfterSeconds", () => {
    expect(
      secondsUntilReset({ code: "rate_limited", message: "", retryAfterSeconds: 30 }, NOW_MS),
    ).toBe(30);
  });

  it("is zero once the reset time has passed", () => {
    expect(
      secondsUntilReset({ code: "rate_limited", message: "", resetAt: NOW_MS / 1000 - 10 }, NOW_MS),
    ).toBe(0);
  });

  it("is undefined when neither is known", () => {
    expect(secondsUntilReset({ code: "rate_limited", message: "" }, NOW_MS)).toBeUndefined();
  });
});

describe("formatWait", () => {
  it.each([
    [1, "1 second"],
    [45, "45 seconds"],
    [60, "1 minute"],
    [119, "2 minutes"],
    [3600, "1 hour"],
    [7200, "2 hours"],
    [86_400, "1 day"],
    [172_800, "2 days"],
  ])("formats %i seconds as %j", (seconds, text) => {
    expect(formatWait(seconds)).toBe(text);
  });
});

describe("chatErrorCopy", () => {
  it("names the minute window and when it resets", () => {
    expect(
      chatErrorCopy(
        { code: "rate_limited", message: "", limitKind: "per_minute", retryAfterSeconds: 45 },
        NOW_MS,
      ),
    ).toEqual({
      title: "You've reached your chat limit for this minute",
      detail: "Try again in 45 seconds.",
    });
  });

  it.each([
    ["daily", "You've reached your chat limit for today"],
    ["monthly", "You've reached your chat limit for this month"],
  ])("names the %s window", (limitKind, title) => {
    expect(
      chatErrorCopy({ code: "rate_limited", message: "", limitKind: limitKind as "daily" }, NOW_MS)
        .title,
    ).toBe(title);
  });

  it("says chat is busy for a global limit", () => {
    expect(
      chatErrorCopy({ code: "rate_limited", message: "", limitKind: "global" }, NOW_MS),
    ).toEqual({
      title: "Chat is busy right now",
      detail: "Please try again shortly.",
    });
  });

  it("uses a generic rate-limit title when no window is given", () => {
    expect(chatErrorCopy({ code: "rate_limited", message: "" }, NOW_MS).title).toBe(
      "You've reached your chat limit",
    );
  });

  it("computes the wait from resetAt against the given clock", () => {
    expect(
      chatErrorCopy(
        { code: "rate_limited", message: "", resetAt: NOW_MS / 1000 + 3600 },
        NOW_MS,
      ).detail,
    ).toBe("Try again in 1 hour.");
  });

  it("shows the invalid_request message, or a default", () => {
    expect(
      chatErrorCopy({ code: "invalid_request", message: "Message is too long." }).detail,
    ).toBe("Message is too long.");
    expect(chatErrorCopy({ code: "invalid_request", message: "" }).detail).toBe(
      "Check the message and try again.",
    );
  });

  it("gives every code a title and no braces or angle brackets", () => {
    const infos = [
      { code: "unauthenticated", message: "" },
      { code: "premium_required", message: "" },
      { code: "rate_limited", message: "", limitKind: "daily" },
      { code: "invalid_request", message: "" },
      { code: "unavailable", message: "" },
    ] as const;
    for (const info of infos) {
      const copy = chatErrorCopy(info, NOW_MS);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(`${copy.title} ${copy.detail ?? ""}`).not.toMatch(/[{}<>]/);
    }
  });
});
