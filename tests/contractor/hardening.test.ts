/**
 * The three things that only matter once the service is hosted rather than run
 * on a laptop: what url the 402 advertises when TLS is terminated in front of
 * it, how hard the one token-gated route can be hammered, and what the
 * responses say about the software underneath.
 *
 * The first suite runs the real `@x402/express` gate against a facilitator
 * stub, because the url in the quote is built by that middleware and not by
 * this repository — a test that asserted our own formula would prove nothing
 * about the header a customer actually receives.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DELIVER_RATE_LIMIT_MAX,
  type ContractorConfig,
  createContractorApp,
  createPaymentGate,
} from "../../contractor/server";
import { JobStore } from "../../contractor/store";
import {
  CONTRACTOR_HANDLE,
  CONTRACTOR_KEY,
  PAYEE_ACCOUNT,
  TOPIC_ID,
  anchorStub,
} from "./helpers";

const DELIVER_TOKEN = "local-token";

/**
 * Base configuration; the facilitator url is filled in per suite.
 *
 * @param facilitatorUrl - Where the gate fetches supported kinds from
 * @returns The configuration
 */
function config(facilitatorUrl = "https://api.testnet.blocky402.com"): ContractorConfig {
  return {
    topicId: TOPIC_ID,
    network: "hedera:testnet",
    asset: "0.0.0",
    payTo: PAYEE_ACCOUNT,
    facilitatorUrl,
    intakeTinybars: 1_000_000,
    balanceTinybars: 4_000_000,
    handle: CONTRACTOR_HANDLE,
    signingKeyHex: CONTRACTOR_KEY,
    deliverToken: DELIVER_TOKEN,
    port: 0,
  };
}

/**
 * Starts an Express app on an ephemeral port.
 *
 * @param app - The application
 * @returns The server and its base url
 */
async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/**
 * Closes a server.
 *
 * @param server - The server to close
 */
async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

/**
 * Reads the x402 quote out of a 402 response.
 *
 * @param response - The 402 response
 * @returns The decoded `payment-required` header
 */
function quote(response: Response): { resource: { url: string } } {
  const header = response.headers.get("payment-required");
  if (!header) {
    throw new Error("The 402 carried no payment-required header");
  }
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { resource: { url: string } };
}

describe("the advertised resource url behind a TLS proxy", () => {
  let facilitator: Server;
  let contractor: Server;
  let dir: string;
  let baseUrl: string;

  beforeEach(async () => {
    // The facilitator is consulted for supported kinds before the gate can
    // quote anything; this stub answers exactly what the testnet one answers
    // for `exact` on `hedera:testnet`, so no test needs the network.
    const stub = express();
    stub.get("/supported", (_req, res) => {
      res.json({
        x402Version: 2,
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: "hedera:testnet",
            extra: { feePayer: "0.0.7162784" },
          },
        ],
        extensions: [],
        signers: { "hedera:*": ["0.0.7162784"] },
      });
    });
    const started = await listen(stub);
    facilitator = started.server;

    dir = mkdtempSync(join(tmpdir(), "contractor-hardening-"));
    const settings = config(started.url);
    const { gate, settlements } = createPaymentGate(settings);
    const app = createContractorApp({
      config: settings,
      store: JobStore.open(join(dir, "jobs.json")),
      anchors: anchorStub().write,
      settlements,
      paymentGate: gate,
    });
    const running = await listen(app);
    contractor = running.server;
    baseUrl = running.url;
  });

  afterEach(async () => {
    await close(contractor);
    await close(facilitator);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Asks for an order without paying, which is what produces the quote.
   *
   * @param headers - Extra request headers
   * @returns The 402 response
   */
  async function unpaidOrder(headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}/mandates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: "{}",
    });
  }

  it("advertises https when the proxy says the request arrived over https", async () => {
    const response = await unpaidOrder({ "X-Forwarded-Proto": "https" });

    expect(response.status).toBe(402);
    expect(quote(response).resource.url.startsWith("https://")).toBe(true);
  });

  it("advertises http locally, where nothing terminates TLS in front", async () => {
    const response = await unpaidOrder();

    expect(response.status).toBe(402);
    expect(quote(response).resource.url.startsWith("http://")).toBe(true);
  });

  it("points at the route that was asked for, not at the host alone", async () => {
    const response = await unpaidOrder({ "X-Forwarded-Proto": "https" });

    expect(quote(response).resource.url.endsWith("/mandates")).toBe(true);
  });
});

describe("the delivery route's rate limit", () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "contractor-hardening-rl-"));
    // No payment is involved in any request this suite makes; the gate is a
    // pass-through so the limit is the only thing being measured.
    const passThrough: RequestHandler = (_req, _res, next) => next();
    const app = createContractorApp({
      config: config(),
      store: JobStore.open(join(dir, "jobs.json")),
      anchors: anchorStub().write,
      settlements: { claim: () => undefined },
      paymentGate: passThrough,
    });
    const running = await listen(app);
    server = running.server;
    baseUrl = running.url;
  });

  afterEach(async () => {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Calls the delivery route.
   *
   * @param token - The token to present
   * @returns The response
   */
  async function deliver(token = "wrong-token"): Promise<Response> {
    return fetch(`${baseUrl}/mandates/wo-does-not-exist/deliver`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Contractor-Token": token },
      body: "{}",
    });
  }

  it("answers 429 once one address is past the limit inside the window", async () => {
    for (let attempt = 0; attempt < DELIVER_RATE_LIMIT_MAX; attempt += 1) {
      expect((await deliver()).status).toBe(401);
    }

    const blocked = await deliver();

    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({
      error: "Too many delivery calls from this address; try again later",
    });
  });

  it("counts before the token is checked, so guessing it is limited too", async () => {
    for (let attempt = 0; attempt < DELIVER_RATE_LIMIT_MAX; attempt += 1) {
      await deliver();
    }

    // A correct token does not buy its way past a limit that has been reached.
    expect((await deliver(DELIVER_TOKEN)).status).toBe(429);
  });

  it("leaves the other routes alone", async () => {
    for (let attempt = 0; attempt < DELIVER_RATE_LIMIT_MAX + 1; attempt += 1) {
      await deliver();
    }

    const health = await fetch(`${baseUrl}/health`);
    const card = await fetch(`${baseUrl}/.well-known/agent.json`);

    expect(health.status).toBe(200);
    expect(card.status).toBe(200);
  });
});

describe("what the responses say about the software", () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "contractor-hardening-hdr-"));
    const app = createContractorApp({
      config: config(),
      store: JobStore.open(join(dir, "jobs.json")),
      anchors: anchorStub().write,
      settlements: { claim: () => undefined },
      paymentGate: (_req, _res, next) => next(),
    });
    const running = await listen(app);
    server = running.server;
    baseUrl = running.url;
  });

  afterEach(async () => {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  });

  it("names no framework on any route, found or not", async () => {
    const responses = await Promise.all([
      fetch(`${baseUrl}/health`),
      fetch(`${baseUrl}/.well-known/agent.json`),
      fetch(`${baseUrl}/mandates/wo-does-not-exist/receipt`),
      fetch(`${baseUrl}/nothing-here`),
    ]);

    for (const response of responses) {
      expect(response.headers.get("x-powered-by")).toBeNull();
    }
  });
});
