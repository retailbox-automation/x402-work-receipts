/**
 * Shared fixtures for the contractor tests.
 *
 * The mandate is read from `docs/schemas/examples`, so the tests exercise the
 * same document the schemas are published with rather than a private copy that
 * can drift away from it.
 */
import { readFileSync } from "node:fs";
import { signEnvelope } from "../../protocol/envelope";
import type { Envelope, Mandate } from "../../protocol/types";
import type { AnchorRecord } from "../../anchor/records";

/** Ed25519 secret keys, fixed so a failing test is reproducible. */
export const CUSTOMER_KEY = "1".repeat(64);
export const CONTRACTOR_KEY = "2".repeat(64);

/** Handles of the two synthetic parties. */
export const CUSTOMER_HANDLE = "client-y-pm";
export const CONTRACTOR_HANDLE = "agency-x";

/** The audit topic used by the tests; no message is written to it. */
export const TOPIC_ID = "0.0.10366000";

/** A settled payment as the facilitator reports it. */
export const INTAKE_TX_ID = "0.0.7162784@1788539653.433840739";
export const BALANCE_TX_ID = "0.0.7162784@1788540153.262607741";

/** Hedera accounts of the paying and the receiving agent. */
export const PAYER_ACCOUNT = "0.0.10365982";
export const PAYEE_ACCOUNT = "0.0.10365984";

/**
 * Reads the published `mandate.v1` example.
 *
 * @param overrides - Fields to replace
 * @returns A valid mandate
 */
export function mandateFixture(overrides: Partial<Mandate> = {}): Mandate {
  const example = JSON.parse(
    readFileSync(new URL("../../docs/schemas/examples/mandate.v1.example.json", import.meta.url), "utf8"),
  ) as Mandate;
  return { ...example, ...overrides };
}

/**
 * Signs a mandate into a customer envelope.
 *
 * @param mandate - The mandate to wrap
 * @param overrides - Envelope fields to replace
 * @returns The signed envelope
 */
export function mandateEnvelope(
  mandate: Mandate = mandateFixture(),
  overrides: Partial<Omit<Envelope<Mandate>, "sig" | "data">> = {},
): Envelope<Mandate> {
  return signEnvelope<Mandate>(
    {
      schema: "mandate.v1",
      from: CUSTOMER_HANDLE,
      to: CONTRACTOR_HANDLE,
      thread_id: `thread-${mandate.mandate_id}`,
      issued_at: mandate.issued_at,
      data: mandate,
      ...overrides,
    },
    CUSTOMER_KEY,
  );
}

/** An anchor writer that records what it was asked to write instead of paying for HCS. */
export type AnchorStub = {
  write: (record: AnchorRecord) => Promise<{ seq: number; consensus_ts: string }>;
  records: AnchorRecord[];
  fail: (message: string | null) => void;
};

/**
 * Builds an in-memory anchor writer.
 *
 * Sequence numbers and consensus timestamps ascend the way a real topic's do,
 * so ordering assertions in the tests mean the same thing they will on chain.
 *
 * @returns The stub
 */
export function anchorStub(): AnchorStub {
  const records: AnchorRecord[] = [];
  let failure: string | null = null;
  return {
    records,
    fail(message: string | null) {
      failure = message;
    },
    async write(record: AnchorRecord) {
      if (failure) {
        throw new Error(failure);
      }
      records.push(record);
      const seq = records.length;
      return { seq, consensus_ts: `178860000${seq}.00000000${seq}` };
    },
  };
}
