/**
 * @jest-environment node
 */
import type { MessagePayload } from "../api";
import { editOriginal, followUp, messageBody } from "../rest";

const message: MessagePayload = {
  embeds: [{ title: "BHP", image: { url: "attachment://BHP-short-1y.png" } }],
  allowed_mentions: { parse: [] },
};
const card = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe("messageBody", () => {
  it("is JSON without files", () => {
    const { body, headers } = messageBody(message);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(body as string)).toEqual(message);
  });

  it("is Discord's multipart form with them, listing them as the attachments", async () => {
    const { body, headers } = messageBody({
      ...message,
      files: [
        {
          name: "BHP-short-1y.png",
          data: card,
          contentType: "image/png",
          description: "BHP short interest chart, past year",
        },
      ],
    });
    // fetch writes the boundary into the Content-Type itself.
    expect(headers["Content-Type"]).toBeUndefined();
    const form = body as FormData;
    const payload = JSON.parse(form.get("payload_json") as string) as Record<
      string,
      unknown
    >;
    expect(payload.files).toBeUndefined();
    expect(payload.attachments).toEqual([
      {
        id: 0,
        filename: "BHP-short-1y.png",
        description: "BHP short interest chart, past year",
      },
    ]);
    expect(payload.embeds).toEqual(message.embeds);
    const file = form.get("files[0]") as File;
    expect(file.name).toBe("BHP-short-1y.png");
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(card);
  });
});

describe("editOriginal", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("patches the original response with the upload", async () => {
    const fetchMock = jest.fn(async () => new Response(null, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await editOriginal("app-1", "tok-1", {
      ...message,
      files: [
        { name: "BHP-short-1y.png", data: card, contentType: "image/png" },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://discord.com/api/v10/webhooks/app-1/tok-1/messages/@original",
    );
    expect(init.method).toBe("PATCH");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("names the failure without the token", async () => {
    global.fetch = jest.fn(
      async () => new Response("bad", { status: 400 }),
    ) as unknown as typeof fetch;
    const token = "t".repeat(80);
    await expect(editOriginal("app-1", token, message)).rejects.toThrow(
      /PATCH \/webhooks\/app-1\/<token>\/messages\/@original -> 400: bad/,
    );
  });
});

describe("retries", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  // What fetch answers, with just what rest.ts reads.
  const answer = (status: number, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => "",
  });

  function fetchAnswering(...answers: (number | Error)[]) {
    const mock = jest.fn(async () => {
      const next = answers.shift() ?? 200;
      if (next instanceof Error) throw next;
      return answer(next, next === 429 ? { "retry-after": "0.01" } : {});
    });
    global.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  it("tries an edit again after a 5xx, and after Discord's rate limit", async () => {
    const fetchMock = fetchAnswering(502, 429, 200);
    await editOriginal("app-1", "tok-1", message);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends the upload afresh on each attempt", async () => {
    const fetchMock = fetchAnswering(500, 200);
    await editOriginal("app-1", "tok-1", {
      ...message,
      files: [{ name: "a.png", data: card, contentType: "image/png" }],
    });
    const bodies = (
      fetchMock.mock.calls as unknown as [string, RequestInit][]
    ).map(([, init]) => init.body);
    expect(bodies[0]).toBeInstanceOf(FormData);
    expect(bodies[1]).toBeInstanceOf(FormData);
    expect(bodies[1]).not.toBe(bodies[0]);
  });

  it("tries an edit again after a dropped connection", async () => {
    const fetchMock = fetchAnswering(new Error("socket hang up"), 200);
    await editOriginal("app-1", "tok-1", message);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never resends a follow-up after a dropped connection, which may have posted it", async () => {
    const fetchMock = fetchAnswering(new Error("socket hang up"), 200);
    await expect(followUp("app-1", "tok-1", message)).rejects.toThrow(
      "socket hang up",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("takes any other answer as final", async () => {
    const fetchMock = fetchAnswering(404, 200);
    await expect(editOriginal("app-1", "tok-1", message)).rejects.toThrow(
      /-> 404/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after three attempts", async () => {
    const fetchMock = fetchAnswering(503, 503, 503, 200);
    await expect(editOriginal("app-1", "tok-1", message)).rejects.toThrow(
      /-> 503/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
