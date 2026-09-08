/**
 * The verifier's only source of truth: the public mirror node.
 *
 * These tests stub `fetch` rather than pointing the reader at a local server,
 * because the address itself is part of what is being asserted — a verifier
 * that could be aimed at a private endpoint would prove nothing to a stranger.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIRROR_NODE_URL,
  MirrorError,
  readTopicAnchors,
  readTransaction,
} from "../../verifier/mirror";
import { goldenTopicPage } from "./helpers";

/** Retry without waiting, so a failure path costs a test no wall-clock time. */
const FAST = { attempts: 3, delayMs: 0 };

/**
 * Builds a JSON `Response`.
 *
 * @param body - Response body
 * @param status - HTTP status, 200 by default
 * @returns The response
 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stubs `fetch` with one canned answer per call and records the urls asked for.
 *
 * @param answers - Answers in call order; the last one repeats
 * @returns The recorded urls
 */
function stubFetch(answers: (Response | (() => Response | Promise<Response>))[]): string[] {
  const urls: string[] = [];
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      urls.push(String(input));
      const answer = answers[Math.min(call, answers.length - 1)];
      call++;
      return typeof answer === "function" ? await answer() : answer;
    }),
  );
  return urls;
}

/**
 * Stubs `fetch` with url-aware answers, for the cases where the messages
 * endpoint and the topic endpoint must disagree.
 *
 * @param routes - Answer for `/messages` and answer for `/topics/{id}`
 * @returns The recorded urls
 */
function stubRoutes(routes: { messages: Response; topic: Response }): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      return url.includes("/messages") ? routes.messages.clone() : routes.topic.clone();
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mirror reads", () => {
  it("reads the public testnet mirror node and nothing else", async () => {
    const urls = stubFetch([json(goldenTopicPage())]);
    await readTopicAnchors("0.0.10426298", FAST);
    expect(urls).toHaveLength(1);
    expect(urls[0].startsWith(`${MIRROR_NODE_URL}/api/v1/`)).toBe(true);
    expect(MIRROR_NODE_URL).toBe("https://testnet.mirrornode.hedera.com");
  });

  it("asks for messages oldest first", async () => {
    const urls = stubFetch([json(goldenTopicPage())]);
    await readTopicAnchors("0.0.10426298", FAST);
    expect(urls[0]).toContain("/topics/0.0.10426298/messages");
    expect(urls[0]).toContain("order=asc");
  });

  it("returns every anchor on the recorded page, ascending", async () => {
    stubFetch([json(goldenTopicPage())]);
    const anchors = await readTopicAnchors("0.0.10426298", FAST);
    expect(anchors).toHaveLength(12);
    expect(anchors[0].kind).toBe("mandate_in");
    expect(anchors.map(anchor => anchor.seq)).toEqual([...anchors.map(a => a.seq)].sort((a, b) => a - b));
  });

  it("follows pagination and does not stop at the first page", async () => {
    const page = goldenTopicPage();
    const first = {
      messages: page.messages.slice(0, 6),
      links: { next: "/api/v1/topics/0.0.10426298/messages?limit=100&order=asc&page=2" },
    };
    const second = { messages: page.messages.slice(6), links: { next: null } };
    const urls = stubFetch([json(first), json(second)]);
    const anchors = await readTopicAnchors("0.0.10426298", FAST);
    expect(anchors).toHaveLength(12);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe(`${MIRROR_NODE_URL}/api/v1/topics/0.0.10426298/messages?limit=100&order=asc&page=2`);
  });

  it("skips messages that are not anchors instead of failing on them", async () => {
    const page = goldenTopicPage();
    page.messages.push({
      consensus_timestamp: "1788894600.000000000",
      message: Buffer.from("hello from a stranger", "utf8").toString("base64"),
      sequence_number: 13,
    });
    stubFetch([json(page)]);
    const anchors = await readTopicAnchors("0.0.10426298", FAST);
    expect(anchors).toHaveLength(12);
  });

  it("retries a transient failure and then succeeds", async () => {
    const urls = stubFetch([json({ message: "upstream" }, 502), json(goldenTopicPage())]);
    const anchors = await readTopicAnchors("0.0.10426298", FAST);
    expect(anchors).toHaveLength(12);
    expect(urls).toHaveLength(2);
  });

  it("raises a mirror error when the topic is unknown", async () => {
    stubFetch([json({ _status: { messages: [{ message: "Not found" }] } }, 404)]);
    await expect(readTopicAnchors("0.0.404404", FAST)).rejects.toBeInstanceOf(MirrorError);
  });

  it("raises a mirror error for an unknown topic id instead of reporting an empty trail", async () => {
    // The messages endpoint answers 200 with an empty list for a topic that
    // does not exist, so a mistyped id would otherwise read as "this order was
    // never anchored" — a false statement about the order, not about the id.
    const urls = stubRoutes({
      messages: json({ messages: [], links: { next: null } }),
      topic: json({ _status: { messages: [{ message: "Not found" }] } }, 404),
    });
    await expect(readTopicAnchors("0.0.999999999", FAST)).rejects.toBeInstanceOf(MirrorError);
    expect(urls.some(url => url.endsWith("/topics/0.0.999999999"))).toBe(true);
  });

  it("returns nothing for a real topic that carries no anchors yet", async () => {
    stubRoutes({
      messages: json({ messages: [], links: { next: null } }),
      topic: json({ topic_id: "0.0.10426299" }),
    });
    await expect(readTopicAnchors("0.0.10426299", FAST)).resolves.toEqual([]);
  });

  it("raises a mirror error when every attempt fails", async () => {
    stubFetch([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    await expect(readTopicAnchors("0.0.10426298", FAST)).rejects.toBeInstanceOf(MirrorError);
  });
});

describe("transaction reads", () => {
  const TX_FACILITATOR = "0.0.7162784@1788894509.185405540";
  const TX_MIRROR = "0.0.7162784-1788894509-185405540";
  const BODY = {
    transactions: [
      {
        transaction_id: TX_MIRROR,
        result: "SUCCESS",
        name: "CRYPTOTRANSFER",
        consensus_timestamp: "1788894516.888218989",
        charged_tx_fee: 251244,
        transfers: [{ account: "0.0.10365984", amount: 1000000, is_approval: false }],
      },
    ],
  };

  it("converts a facilitator transaction id to the form the mirror node uses", async () => {
    const urls = stubFetch([json(BODY)]);
    const transaction = await readTransaction(TX_FACILITATOR, FAST);
    expect(urls[0]).toBe(`${MIRROR_NODE_URL}/api/v1/transactions/${TX_MIRROR}`);
    expect(transaction?.result).toBe("SUCCESS");
  });

  it("accepts an id that is already in mirror form", async () => {
    const urls = stubFetch([json(BODY)]);
    await readTransaction(TX_MIRROR, FAST);
    expect(urls[0]).toContain(TX_MIRROR);
  });

  it("answers null for a transaction the ledger does not have", async () => {
    stubFetch([json({ _status: { messages: [{ message: "Not found" }] } }, 404)]);
    await expect(readTransaction(TX_MIRROR, FAST)).resolves.toBeNull();
  });

  it("answers null when the mirror node returns an empty list", async () => {
    stubFetch([json({ transactions: [] })]);
    await expect(readTransaction(TX_MIRROR, FAST)).resolves.toBeNull();
  });

  it("prefers the successful entry when a transaction id has several records", async () => {
    stubFetch([
      json({
        transactions: [
          { ...BODY.transactions[0], result: "DUPLICATE_TRANSACTION", nonce: 1 },
          BODY.transactions[0],
        ],
      }),
    ]);
    const transaction = await readTransaction(TX_MIRROR, FAST);
    expect(transaction?.result).toBe("SUCCESS");
  });

  it("raises a mirror error rather than reporting a missing transaction when the read fails", async () => {
    stubFetch([json({ message: "boom" }, 503)]);
    await expect(readTransaction(TX_MIRROR, FAST)).rejects.toBeInstanceOf(MirrorError);
  });
});
