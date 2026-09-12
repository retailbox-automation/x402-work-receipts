/**
 * The browser verifier, end to end through the real routes.
 *
 * The mirror reads are injected from the same recorded snapshot the verifier's
 * own suite uses, so these tests exercise the actual handler, the actual checks
 * and the actual status codes without touching the network. What they are
 * really pinning down is the one distinction the page exists to preserve: a
 * receipt that does not hold up is a successful verification with a negative
 * answer (200, exit 1), while a mirror node that could not be read is not an
 * answer at all (502, exit 2). Collapsing those two would let the page state a
 * verdict it never reached.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ContractorConfig, createContractorApp } from "../../contractor/server";
import { JobStore } from "../../contractor/store";
import { toMirrorTxId } from "../../anchor/records";
import type { AnchorEntry } from "../../anchor/records";
import type { VerifyDeps } from "../../verifier/cli";
import { MirrorError } from "../../verifier/mirror";
import type { MirrorTransaction } from "../../verifier/mirror";
import type { Envelope, PaymentReceipt } from "../../protocol/types";
import {
  GOLDEN_TOPIC,
  anchorsFrom,
  fixture,
  goldenMandate,
  goldenReceipt,
  goldenTopicPage,
  goldenTransactions,
} from "../verifier/helpers";
import {
  CONTRACTOR_HANDLE,
  CONTRACTOR_KEY,
  PAYEE_ACCOUNT,
  TOPIC_ID,
  anchorStub,
} from "./helpers";

/**
 * Configuration for a contractor that is never paid in these tests.
 *
 * @returns The configuration
 */
function config(): ContractorConfig {
  return {
    topicId: TOPIC_ID,
    network: "hedera:testnet",
    asset: "0.0.0",
    payTo: PAYEE_ACCOUNT,
    facilitatorUrl: "https://api.testnet.blocky402.com",
    intakeTinybars: 1_000_000,
    balanceTinybars: 4_000_000,
    handle: CONTRACTOR_HANDLE,
    signingKeyHex: CONTRACTOR_KEY,
    deliverToken: "local-token",
    port: 0,
  };
}

/**
 * Mirror readers backed by the recorded snapshot.
 *
 * @returns Injectable dependencies that read no network
 */
function offlineDeps(): VerifyDeps {
  const anchors = anchorsFrom(goldenTopicPage());
  const transactions = goldenTransactions();
  return {
    readAnchors: async (): Promise<AnchorEntry[]> => anchors,
    readTransaction: async (id: string): Promise<MirrorTransaction | null> =>
      transactions.get(toMirrorTxId(id)) ?? null,
  };
}

/** Readers that cannot answer at all. */
function brokenDeps(): VerifyDeps {
  return {
    readAnchors: async (): Promise<AnchorEntry[]> => {
      throw new MirrorError("the mirror node answered 503");
    },
    readTransaction: async (): Promise<MirrorTransaction | null> => null,
  };
}

/**
 * Starts an app on an ephemeral port.
 *
 * @param app - The application
 * @returns The server and its base url
 */
async function listen(app: Express): Promise<{ server: Server; url: string }> {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** What `POST /verify` answers with. */
type VerifyAnswer = {
  ok: boolean;
  results: { name: string; ok: boolean; detail: string; applicable?: boolean }[];
  summary: string;
  statement: string;
  links: {
    topic: { id: string; url: string };
    anchors: { seq: number; kind: string; url: string }[];
    transactions: { id: string; url: string }[];
  };
  exitCode: number;
  cli: string;
};

describe("the browser verifier", () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;

  /**
   * Boots a contractor whose verifier reads the given snapshot.
   *
   * @param verifier - Mirror readers to inject
   */
  async function boot(verifier: VerifyDeps): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), "contractor-verify-page-"));
    const app = createContractorApp({
      config: config(),
      store: JobStore.open(join(dir, "jobs.json")),
      anchors: anchorStub().write,
      settlements: { claim: () => undefined },
      paymentGate: (_req, _res, next) => next(),
      verifier,
    });
    const running = await listen(app);
    server = running.server;
    baseUrl = running.url;
  }

  /**
   * Posts documents to the verifier.
   *
   * @param body - The request body, as an object or a raw string
   * @returns The response
   */
  async function post(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  describe("with a mirror node that answers", () => {
    beforeEach(async () => {
      await boot(offlineDeps());
    });

    it("serves the page with the button that fills it in", async () => {
      const response = await fetch(`${baseUrl}/verify`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);
      expect(body).toContain("Load the demo run");
      // The form starts on this instance's own topic.
      expect(body).toContain(TOPIC_ID);
    });

    it("offers a real bundled run, work order and all", async () => {
      const response = await fetch(`${baseUrl}/verify/demo`);
      const run = (await response.json()) as {
        receipt: Envelope<PaymentReceipt>;
        mandate: Envelope<unknown>;
        topicId: string;
      };

      expect(response.status).toBe(200);
      expect(run.receipt.schema).toBe("receipt.v1+payment.v1");
      expect(run.mandate.schema).toBe("mandate.v1");
      expect(run.topicId).toMatch(/^\d+\.\d+\.\d+$/);
      // The run has to be checked against the topic that carries its anchors,
      // not against whatever topic this instance is configured for.
      expect(run.receipt.data.mandate_id).toBeTruthy();
    });

    it("verifies the golden run and says so, with links to the evidence", async () => {
      const response = await post({
        topicId: GOLDEN_TOPIC,
        receipt: goldenReceipt(),
        mandate: goldenMandate(),
      });
      const answer = (await response.json()) as VerifyAnswer;

      expect(response.status).toBe(200);
      expect(answer.ok).toBe(true);
      expect(answer.exitCode).toBe(0);
      expect(answer.summary).toContain("VERIFIED");
      expect(answer.results.filter(result => !result.ok)).toEqual([]);
      expect(answer.statement).toContain("What the chain proves");
      expect(answer.links.topic.url).toContain(GOLDEN_TOPIC);
      expect(answer.links.anchors.length).toBeGreaterThan(0);
      expect(answer.links.transactions.length).toBeGreaterThan(0);
      expect(answer.cli).toContain(`--topic ${GOLDEN_TOPIC}`);
    });

    it("verifies without the optional work order", async () => {
      const response = await post({ topicId: GOLDEN_TOPIC, receipt: goldenReceipt() });
      const answer = (await response.json()) as VerifyAnswer;

      expect(response.status).toBe(200);
      expect(answer.ok).toBe(true);
      expect(answer.cli).not.toContain("--mandate");
    });

    it("answers 200 with a failed verdict for a tampered receipt", async () => {
      const response = await post({
        topicId: GOLDEN_TOPIC,
        receipt: fixture("../verifier/tampered/wrong-payee.json"),
      });
      const answer = (await response.json()) as VerifyAnswer;

      // A negative answer is still an answer: the verification ran.
      expect(response.status).toBe(200);
      expect(answer.ok).toBe(false);
      expect(answer.exitCode).toBe(1);
      expect(answer.results.some(result => !result.ok)).toBe(true);
      expect(answer.summary).toContain("NOT VERIFIED");
    });

    it("refuses a body that is not a receipt, in the verifier's own words", async () => {
      const response = await post({ topicId: GOLDEN_TOPIC, receipt: { hello: "world" } });
      const answer = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(answer.error).toContain("does not hold a signed envelope");
    });

    it("refuses a document of the wrong kind rather than checking it anyway", async () => {
      const response = await post({ topicId: GOLDEN_TOPIC, receipt: goldenMandate() });
      const answer = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(answer.error).toContain("receipt.v1+payment.v1");
    });

    it("refuses a body that is not JSON at all", async () => {
      const response = await post("this is not json");

      expect(response.status).toBe(400);
    });
  });

  describe("with a mirror node that cannot be read", () => {
    beforeEach(async () => {
      await boot(brokenDeps());
    });

    it("answers 502 and exit 2 — not a failed verdict", async () => {
      const response = await post({ topicId: GOLDEN_TOPIC, receipt: goldenReceipt() });
      const answer = (await response.json()) as { ok: boolean; error: string; exitCode: number };

      expect(response.status).toBe(502);
      expect(answer.ok).toBe(false);
      expect(answer.exitCode).toBe(2);
      expect(answer.error).toContain("Could not read the public record");
    });
  });
});
