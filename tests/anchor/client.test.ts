import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "@hiero-ledger/sdk";
import {
  DEFAULT_MIRROR_NODE_URL,
  MirrorTopicNotFoundError,
  formatConsensusTimestamp,
  readAnchors,
} from "../../anchor/client";
import { encodeAnchor, isAnchorRecord, parseAnchor } from "../../anchor/records";

/**
 * A real page of `GET /api/v1/topics/{id}/messages`, recorded from the testnet
 * topic the integration test wrote to. It holds the two anchors plus one
 * message that is not an anchor at all.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/topic-messages.json", import.meta.url), "utf8"),
) as {
  messages: { consensus_timestamp: string; message: string; sequence_number: number }[];
  links: { next: string | null };
};

/** Decoded message bodies from the fixture, in the order the mirror node returned them. */
const FIXTURE_BODIES = FIXTURE.messages.map(message =>
  Buffer.from(message.message, "base64").toString("utf8"),
);

/** The fixture messages that really are anchors. */
const FIXTURE_ANCHORS = FIXTURE.messages.filter((_, index) => parseAnchor(FIXTURE_BODIES[index]));

/**
 * Serves canned mirror-node responses and records every URL requested.
 *
 * @param pages - One response body per call; the last one repeats
 * @returns The stub and the list of requested URLs
 */
function stubMirror(
  pages: (unknown | (() => Response))[],
  topicInfo?: () => Response,
): { urls: string[]; messageUrls: () => string[] } {
  const urls: string[] = [];
  let messageCalls = 0;
  const fetchStub = vi.fn(async (input: string | URL) => {
    const url = String(input);
    urls.push(url);

    if (!url.includes("/messages")) {
      return topicInfo ? topicInfo() : json({ topic_id: "0.0.123456" });
    }

    const page = pages[Math.min(messageCalls, pages.length - 1)];
    messageCalls++;
    return typeof page === "function" ? (page as () => Response)() : json(page);
  });
  vi.stubGlobal("fetch", fetchStub);
  return { urls, messageUrls: () => urls.filter(url => url.includes("/messages")) };
}

/**
 * Wraps a value in a 200 JSON response.
 *
 * @param body - Response body
 * @returns The response
 */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** An empty page, which is what the mirror node returns while it lags consensus. */
const EMPTY_PAGE = { messages: [], links: { next: null } };

beforeEach(() => {
  // Keep the retry window short so the lag paths are testable in milliseconds.
  vi.stubEnv("ANCHOR_MIRROR_TIMEOUT_MS", "300");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("readAnchors", () => {
  it("parses a recorded mirror-node page into anchors", async () => {
    stubMirror([FIXTURE]);

    const entries = await readAnchors("0.0.123456");

    expect(entries.length).toBe(FIXTURE_ANCHORS.length);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const [index, entry] of entries.entries()) {
      const source = FIXTURE_ANCHORS[index];
      expect(entry.seq).toBe(source.sequence_number);
      expect(entry.consensus_ts).toBe(source.consensus_timestamp);
      expect(isAnchorRecord(entry)).toBe(true);
    }
  });

  it("returns anchors in ascending sequence order", async () => {
    stubMirror([FIXTURE]);

    const entries = await readAnchors("0.0.123456");
    const sequences = entries.map(entry => entry.seq);

    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("re-encodes each anchor to exactly the bytes that were submitted", async () => {
    stubMirror([FIXTURE]);

    const entries = await readAnchors("0.0.123456");

    for (const entry of entries) {
      const { seq, consensus_ts, ...record } = entry;
      expect(seq).toBeGreaterThan(0);
      expect(consensus_ts).toMatch(/^\d+\.\d{9}$/);
      expect(FIXTURE_BODIES).toContain(encodeAnchor(record));
    }
  });

  it("skips messages on the topic that are not anchors", async () => {
    stubMirror([FIXTURE]);

    const entries = await readAnchors("0.0.123456");

    // The fixture deliberately carries a non-anchor message: a public topic has
    // no submit key, so a reader has to tolerate strangers writing to it.
    expect(FIXTURE.messages.length).toBeGreaterThan(entries.length);
  });

  it("asks the mirror node for the topic, ascending, and follows pagination", async () => {
    const [first, ...rest] = FIXTURE.messages;
    const firstPage = {
      messages: [first],
      links: { next: `/api/v1/topics/0.0.123456/messages?limit=100&order=asc&timestamp=gt:1` },
    };
    const secondPage = { messages: rest, links: { next: null } };
    const { urls } = stubMirror([firstPage, secondPage]);

    const entries = await readAnchors("0.0.123456");

    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(
      `${DEFAULT_MIRROR_NODE_URL}/api/v1/topics/0.0.123456/messages?limit=100&order=asc`,
    );
    expect(urls[1]).toBe(`${DEFAULT_MIRROR_NODE_URL}${firstPage.links.next}`);
    expect(entries.length).toBe(FIXTURE_ANCHORS.length);
  });

  it("passes `since` to the mirror node as a timestamp filter", async () => {
    const { urls } = stubMirror([FIXTURE]);

    await readAnchors("0.0.123456", { since: "1788539659.779738844" });

    expect(urls[0]).toContain("timestamp=gt%3A1788539659.779738844");
  });

  it("reads from HEDERA_MIRROR_NODE_URL when one is configured", async () => {
    vi.stubEnv("HEDERA_MIRROR_NODE_URL", "https://mainnet-public.mirrornode.hedera.com/");
    const { urls } = stubMirror([FIXTURE]);

    await readAnchors("0.0.123456");

    expect(urls[0]).toBe(
      "https://mainnet-public.mirrornode.hedera.com/api/v1/topics/0.0.123456/messages?limit=100&order=asc",
    );
  });

  it("retries while the mirror node still lags consensus", async () => {
    const { urls } = stubMirror([EMPTY_PAGE, FIXTURE]);

    const entries = await readAnchors("0.0.123456");

    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(entries.length).toBe(FIXTURE_ANCHORS.length);
  });

  it("gives up with an empty result when the topic exists and really has no anchors", async () => {
    const { messageUrls } = stubMirror([EMPTY_PAGE]);

    const entries = await readAnchors("0.0.123456");

    expect(entries).toEqual([]);
    expect(messageUrls().length).toBeGreaterThan(1);
  });

  it("refuses to report an unknown topic as an empty one", async () => {
    // The messages endpoint answers 200 with an empty list for a topic that does
    // not exist, so a mistyped topic id would otherwise read as "never anchored".
    const { urls } = stubMirror([EMPTY_PAGE], () => new Response("topic not found", { status: 404 }));

    await expect(readAnchors("0.0.999999")).rejects.toThrow(MirrorTopicNotFoundError);
    expect(urls.at(-1)).toBe(`${DEFAULT_MIRROR_NODE_URL}/api/v1/topics/0.0.999999`);
  });

  it("retries a 404 from the messages endpoint instead of reading it as empty", async () => {
    const { messageUrls } = stubMirror([() => new Response("not found", { status: 404 })]);

    await expect(readAnchors("0.0.999999")).rejects.toThrow(MirrorTopicNotFoundError);
    expect(messageUrls().length).toBeGreaterThan(1);
  });

  it("surfaces a mirror node error once the retry window is spent", async () => {
    stubMirror([() => new Response("boom", { status: 500 })]);

    await expect(readAnchors("0.0.123456")).rejects.toThrow(/answered 500/);
  });

  it("treats a 404 in the middle of pagination as an error, not as the end", async () => {
    vi.stubEnv("ANCHOR_MIRROR_TIMEOUT_MS", "0");
    const firstPage = {
      messages: FIXTURE.messages,
      links: { next: "/api/v1/topics/0.0.123456/messages?limit=100&order=asc&timestamp=gt:1" },
    };
    stubMirror([firstPage, () => new Response("not found", { status: 404 })]);

    // Stopping here would hand back a truncated log: two anchors read, the rest
    // of the topic silently dropped.
    await expect(readAnchors("0.0.123456")).rejects.toThrow(/answered 404/);
  });

  it("refuses to return a truncated log when pagination never ends", async () => {
    vi.stubEnv("ANCHOR_MIRROR_TIMEOUT_MS", "0");
    const endlessPage = {
      messages: FIXTURE.messages,
      links: { next: "/api/v1/topics/0.0.123456/messages?limit=100&order=asc&timestamp=gt:1" },
    };
    stubMirror([endlessPage]);

    await expect(readAnchors("0.0.123456")).rejects.toThrow(/truncated log/);
  });

  it("makes a single attempt when the retry window is zero", async () => {
    vi.stubEnv("ANCHOR_MIRROR_TIMEOUT_MS", "0");
    const { messageUrls } = stubMirror([EMPTY_PAGE]);

    await expect(readAnchors("0.0.123456")).resolves.toEqual([]);
    expect(messageUrls()).toHaveLength(1);
  });
});

describe("formatConsensusTimestamp", () => {
  it("prints nine nanosecond digits, the way the mirror node does", () => {
    expect(formatConsensusTimestamp(new Timestamp(1788541611, 325778104))).toBe(
      "1788541611.325778104",
    );
    // A real testnet timestamp whose nanoseconds start with zeros: without
    // padding this would read as a different instant.
    expect(formatConsensusTimestamp(new Timestamp(1788541858, 8959007))).toBe(
      "1788541858.008959007",
    );
    expect(formatConsensusTimestamp(new Timestamp(1788541858, 0))).toBe("1788541858.000000000");
  });
});
