/**
 * The job store is the contractor's only memory between the two paid calls: a
 * mandate is accepted in one HTTP request and its receipt is released in
 * another, possibly days and one restart later. These tests are about that
 * survival — everything written is readable again from a cold open.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signEnvelope } from "../../protocol/envelope";
import type { Envelope, Receipt } from "../../protocol/types";
import { JobStore, type Job } from "../../contractor/store";
import {
  CONTRACTOR_HANDLE,
  CONTRACTOR_KEY,
  CUSTOMER_HANDLE,
  INTAKE_TX_ID,
  PAYEE_ACCOUNT,
  PAYER_ACCOUNT,
  TOPIC_ID,
  mandateEnvelope,
  mandateFixture,
} from "./helpers";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "contractor-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Builds a job in the state it has right after intake.
 *
 * @param mandateId - Mandate id to use
 * @returns The job
 */
function acceptedJob(mandateId = "wo-0001"): Job {
  const envelope = mandateEnvelope(mandateFixture({ mandate_id: mandateId }));
  return {
    mandate_id: mandateId,
    thread_id: envelope.thread_id,
    customer: CUSTOMER_HANDLE,
    contractor: CONTRACTOR_HANDLE,
    mandate: envelope,
    mandate_envelope_hash: "a".repeat(64),
    mandate_anchor: { topic: TOPIC_ID, seq: 1, consensus_ts: "1788600001.000000001" },
    accepted_receipt: acceptedReceiptEnvelope(mandateId),
    payment: {
      network: "hedera:testnet",
      asset: "0.0.0",
      facilitator: "https://api.testnet.blocky402.com",
      payer: PAYER_ACCOUNT,
      payee: PAYEE_ACCOUNT,
      intake: { tinybars: 1_000_000, transaction_id: INTAKE_TX_ID },
    },
    created_at: "2026-09-08T10:00:00.000Z",
    updated_at: "2026-09-08T10:00:00.000Z",
  };
}

/**
 * A signed acceptance receipt, built here from `protocol/` alone so the store
 * tests do not depend on how receipts are assembled.
 *
 * @param mandateId - Mandate the receipt acknowledges
 * @returns The signed envelope
 */
function acceptedReceiptEnvelope(mandateId: string): Envelope<Receipt> {
  const receipt: Receipt = {
    receipt_id: `rc-${mandateId}`,
    kind: "accepted",
    mandate_id: mandateId,
    mandate_envelope_hash: "a".repeat(64),
    mandate_anchor: { topic: TOPIC_ID, seq: 1, consensus_ts: "1788600001.000000001" },
    taken: ["Trades are grouped by calendar day"],
    issued_at: "2026-09-08T10:00:00.000Z",
    issuer: CONTRACTOR_HANDLE,
  };
  return signEnvelope<Receipt>(
    {
      schema: "receipt.v1",
      from: CONTRACTOR_HANDLE,
      to: CUSTOMER_HANDLE,
      thread_id: `thread-${mandateId}`,
      issued_at: receipt.issued_at,
      data: receipt,
    },
    CONTRACTOR_KEY,
  );
}

describe("JobStore", () => {
  it("returns undefined for a mandate it has never seen", () => {
    const store = JobStore.open(join(dir, "jobs.json"));
    expect(store.get("wo-unknown")).toBeUndefined();
    expect(store.has("wo-unknown")).toBe(false);
  });

  it("round-trips a job through a file a second process could read", () => {
    const path = join(dir, "nested", "jobs.json");
    const written = JobStore.open(path).put(acceptedJob());

    // A second store opened on the same path stands in for the restart between
    // accepting a mandate and releasing its receipt.
    const reopened = JobStore.open(path);
    expect(reopened.get("wo-0001")).toEqual(written);
    expect(reopened.list().map(job => job.mandate_id)).toEqual(["wo-0001"]);
  });

  it("keeps the mandate envelope byte-identical so its hash still matches", () => {
    const path = join(dir, "jobs.json");
    const job = acceptedJob();
    JobStore.open(path).put(job);

    const reopened = JobStore.open(path).get("wo-0001");
    expect(JSON.stringify(reopened?.mandate)).toBe(JSON.stringify(job.mandate));
  });

  it("updates a job in place and moves updated_at forward", () => {
    const path = join(dir, "jobs.json");
    const store = JobStore.open(path);
    store.put(acceptedJob());

    const updated = store.update("wo-0001", job => ({
      ...job,
      result: {
        pr_url: "https://git.example.com/agency-x/web/-/merge_requests/101",
        staging_url: "https://staging.example-client.app/preview/abc",
        notion_status: "Testing",
      },
    }));

    expect(updated.result?.notion_status).toBe("Testing");
    expect(Date.parse(updated.updated_at)).toBeGreaterThanOrEqual(Date.parse(updated.created_at));
    expect(JobStore.open(path).get("wo-0001")?.result?.notion_status).toBe("Testing");
  });

  it("refuses to update a job that does not exist", () => {
    const store = JobStore.open(join(dir, "jobs.json"));
    expect(() => store.update("wo-missing", job => job)).toThrow(/wo-missing/);
  });

  it("keeps every job when several are written", () => {
    const path = join(dir, "jobs.json");
    const store = JobStore.open(path);
    store.put(acceptedJob("wo-0001"));
    store.put(acceptedJob("wo-0002"));
    store.put(acceptedJob("wo-0003"));

    expect(JobStore.open(path).list().map(job => job.mandate_id).sort()).toEqual([
      "wo-0001",
      "wo-0002",
      "wo-0003",
    ]);
  });

  it("leaves no temporary file behind after a write", () => {
    const path = join(dir, "jobs.json");
    JobStore.open(path).put(acceptedJob());
    expect(readdirSync(dir)).toEqual(["jobs.json"]);
  });

  it("writes JSON a person can read while debugging a run", () => {
    const path = join(dir, "jobs.json");
    JobStore.open(path).put(acceptedJob());
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("\n");
    expect(JSON.parse(raw)).toMatchObject({ v: "contractor-jobs.v1" });
  });

  it("refuses to open a file that is not a job store rather than overwriting it", () => {
    const path = join(dir, "jobs.json");
    writeFileSync(path, JSON.stringify({ v: "something-else", jobs: {} }), "utf8");
    expect(() => JobStore.open(path)).toThrow(/contractor-jobs\.v1/);
  });
});
