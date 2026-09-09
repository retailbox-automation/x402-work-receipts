/**
 * The customer's identity: when it signs as an identifier rather than a name,
 * and how it learns the contractor's.
 *
 * Discovery is the part worth testing hard, because it talks to a service that
 * may be absent, slow or hostile. Every one of those cases has to end with an
 * order that still goes out, addressed to the handle it was always addressed
 * to — a counterparty's broken card is not the customer's failure.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicKeyHex, verifyEnvelope } from "../../protocol/envelope";
import {
  didKeyFromPublicKey,
  isUaid,
  uaidFromPublicKey,
  uaidMatchesPublicKey,
} from "../../protocol/identity";
import {
  AGENT_CARD_PATH,
  buildMandate,
  buildMandateEnvelope,
  loadStory,
  resolveCounterparty,
} from "../../customer/cli";
import { ConfigError, loadSigningIdentity } from "../../customer/wallet";

const FIXTURE = fileURLToPath(new URL("../../demo/fixtures/story-history-grouping.json", import.meta.url));

const SIGNING_KEY = "55".repeat(32);
const CONTRACTOR_UAID = uaidFromPublicKey(publicKeyHex("66".repeat(32)), { registry: "self" });

/**
 * A minimal customer environment.
 *
 * @param overrides - Values to add or replace
 * @returns The environment
 */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    CUSTOMER_SIGNING_KEY: SIGNING_KEY,
    CUSTOMER_ACCOUNT_ID: "0.0.10365982",
    CUSTOMER_PRIVATE_KEY: "302e020100300506032b657004220420" + "77".repeat(16),
    ...overrides,
  };
}

/**
 * A fetch that answers one agent card and nothing else.
 *
 * @param body - What the card route returns, or an error to throw
 * @param status - HTTP status of that answer
 * @returns A fetch implementation and the urls it was called with
 */
function cardServer(
  body: unknown,
  status = 200,
): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    if (body instanceof Error) {
      throw body;
    }
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, urls };
}

describe("signing as an identifier", () => {
  it("stays on the handle until it is asked not to", () => {
    const identity = loadSigningIdentity(env());
    expect(identity.uaid).toBeUndefined();

    const envelope = buildMandateEnvelope(
      buildMandate(loadStory(FIXTURE), { issuer: identity.handle }),
      identity,
    );
    expect(envelope.from).toBe(identity.agent);
  });

  it("derives an identifier from its signing key on CUSTOMER_UAID=auto", () => {
    const identity = loadSigningIdentity(env({ CUSTOMER_UAID: "auto" }));
    expect(identity.uaid).toBeDefined();
    expect(uaidMatchesPublicKey(identity.uaid!, identity.publicKeyHex)).toBe(true);
    expect(identity.uaid).toContain("nativeId=hedera:testnet:0.0.10365982");
  });

  it("signs the order as that identifier, keeping the handle inside the document", () => {
    const identity = loadSigningIdentity(env({ CUSTOMER_UAID: "auto", CUSTOMER_HANDLE: "client-y" }));
    const mandate = buildMandate(loadStory(FIXTURE), { issuer: identity.handle });
    const envelope = buildMandateEnvelope(mandate, identity);

    expect(envelope.from).toBe(identity.uaid);
    expect(uaidMatchesPublicKey(envelope.from, envelope.sig.pub)).toBe(true);
    expect(envelope.data.issuer).toBe("client-y");
    expect(verifyEnvelope(envelope)).toBe(true);
  });

  it("takes an identifier given verbatim, and refuses a malformed one", () => {
    const given = `uaid:did:${didKeyFromPublicKey(publicKeyHex(SIGNING_KEY))};uid=0;registry=hol`;
    expect(loadSigningIdentity(env({ CUSTOMER_UAID: given })).uaid).toBe(given);
    expect(() => loadSigningIdentity(env({ CUSTOMER_UAID: "uaid:did:" }))).toThrow(ConfigError);
    expect(() => loadSigningIdentity(env({ CUSTOMER_UAID: "not-an-identifier" }))).toThrow(ConfigError);
  });

  it("addresses a counterparty pinned by CONTRACTOR_UAID, and refuses a broken pin", () => {
    const identity = loadSigningIdentity(env({ CONTRACTOR_UAID: CONTRACTOR_UAID }));
    expect(identity.counterparty).toBe(CONTRACTOR_UAID);
    expect(() => loadSigningIdentity(env({ CONTRACTOR_UAID: "uaid:did:a;b" }))).toThrow(ConfigError);
  });

  it("still accepts a counterparty named by handle", () => {
    expect(loadSigningIdentity(env({ CONTRACTOR_AGENT: "agency-x" })).counterparty).toBe("agency-x");
  });
});

describe("resolving the counterparty from its card", () => {
  it("addresses the identifier the card publishes", async () => {
    const identity = loadSigningIdentity(env());
    const server = cardServer({ did: CONTRACTOR_UAID, handle: "agency-x-agent" });

    const resolved = await resolveCounterparty("http://contractor.test/", identity, server.fetch);
    expect(resolved.counterparty).toBe(CONTRACTOR_UAID);
    expect(server.urls).toEqual([`http://contractor.test${AGENT_CARD_PATH}`]);
    // Only the counterparty moves; who we are is not up to them.
    expect({ ...resolved, counterparty: identity.counterparty }).toEqual(identity);
  });

  it("does not ask when the counterparty is already an identifier", async () => {
    const identity = loadSigningIdentity(env({ CONTRACTOR_UAID: CONTRACTOR_UAID }));
    const server = cardServer({ did: "uaid:did:z6MkSomethingElse;uid=0" });

    const resolved = await resolveCounterparty("http://contractor.test", identity, server.fetch);
    expect(resolved.counterparty).toBe(CONTRACTOR_UAID);
    expect(server.urls).toEqual([]);
  });

  it("keeps the handle when the card is missing, unreadable or not an identifier", async () => {
    const identity = loadSigningIdentity(env());
    const cases: Array<{ body: unknown; status?: number }> = [
      { body: { error: "not found" }, status: 404 },
      { body: "<html>nothing here</html>" },
      { body: {} },
      { body: { did: "agency-x-agent" } },
      { body: { did: "uaid:did:" } },
      { body: { did: 42 } },
      { body: new Error("connection refused") },
    ];

    for (const { body, status } of cases) {
      const server = cardServer(body, status ?? 200);
      const resolved = await resolveCounterparty("http://contractor.test", identity, server.fetch);
      expect(resolved.counterparty, JSON.stringify(body)).toBe(identity.counterparty);
      expect(isUaid(resolved.counterparty)).toBe(false);
    }
  });
});
