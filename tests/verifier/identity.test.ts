/**
 * The identity check: does the identifier a receipt comes from name the key
 * that signed it?
 *
 * The golden run predates identifiers — both envelopes carry handles — and it
 * is used here on purpose: a check added later must not turn documents that
 * were always honest into failures, and it must not quietly report a pass for
 * a claim nobody made. Everything with an actual identifier in it is built and
 * signed in this file, because a receipt is only evidence about the key that
 * signed it and a fixture cannot be re-signed without one.
 */
import { describe, expect, it } from "vitest";
import { publicKeyHex, signEnvelope } from "../../protocol/envelope";
import { didKeyFromPublicKey, uaidFromPublicKey } from "../../protocol/identity";
import type { Envelope, Mandate, PaymentReceipt } from "../../protocol/types";
import {
  CHECK_IDENTITY,
  CHECK_NAMES,
  checkAgentIdentity,
  runChecks,
} from "../../verifier/checks";
import type { VerificationInput } from "../../verifier/checks";
import { EXIT_OK, renderTable, verify } from "../../verifier/cli";
import type { VerifyDeps } from "../../verifier/cli";
import type { MirrorTransaction } from "../../verifier/mirror";
import type { AnchorEntry } from "../../anchor/records";
import { toMirrorTxId } from "../../anchor/records";
import {
  GOLDEN_TOPIC,
  anchorsFrom,
  goldenMandate,
  goldenReceipt,
  goldenTransactions,
} from "./helpers";

/**
 * Mirror readers backed by the recorded snapshot of the golden run.
 *
 * @returns Injectable dependencies that read no network
 */
function offlineDeps(): VerifyDeps {
  const anchors = anchorsFrom();
  const transactions = goldenTransactions();
  return {
    readAnchors: async (): Promise<AnchorEntry[]> => anchors,
    readTransaction: async (id: string): Promise<MirrorTransaction | null> =>
      transactions.get(toMirrorTxId(id)) ?? null,
  };
}

/** The contractor of these fixtures, and the customer that ordered from it. */
const CONTRACTOR_KEY = "a1".repeat(32);
const CUSTOMER_KEY = "b2".repeat(32);
const CONTRACTOR_UAID = uaidFromPublicKey(publicKeyHex(CONTRACTOR_KEY), {
  registry: "self",
  proto: "rest",
  nativeId: "hedera:testnet:0.0.10365984",
});
const CUSTOMER_UAID = uaidFromPublicKey(publicKeyHex(CUSTOMER_KEY), { registry: "self" });

/**
 * The golden run, whose envelopes carry handles.
 *
 * @returns Verification input every other check passes
 */
function goldenInput(): VerificationInput {
  return {
    topicId: GOLDEN_TOPIC,
    receipt: goldenReceipt(),
    mandate: goldenMandate(),
    anchors: anchorsFrom(),
    transactions: goldenTransactions(),
  };
}

/**
 * The same run, re-signed by agents that publish identifiers.
 *
 * Only the envelopes change: the documents inside them are the golden run's,
 * so anything this check reports is about identity and nothing else.
 *
 * @param overrides - Envelope fields to change before signing
 * @returns Verification input with identifiers on both sides
 */
function identifiedInput(
  overrides: { receiptFrom?: string; receiptTo?: string; mandateFrom?: string } = {},
): VerificationInput {
  const golden = goldenInput();
  const receipt = signEnvelope<PaymentReceipt>(
    {
      schema: "receipt.v1+payment.v1",
      from: overrides.receiptFrom ?? CONTRACTOR_UAID,
      to: overrides.receiptTo ?? CUSTOMER_UAID,
      thread_id: golden.receipt.thread_id,
      issued_at: golden.receipt.issued_at,
      data: golden.receipt.data,
    },
    CONTRACTOR_KEY,
  );
  const mandate = signEnvelope<Mandate>(
    {
      schema: "mandate.v1",
      from: overrides.mandateFrom ?? CUSTOMER_UAID,
      to: overrides.receiptFrom ?? CONTRACTOR_UAID,
      thread_id: golden.mandate!.thread_id,
      issued_at: golden.mandate!.issued_at,
      data: golden.mandate!.data,
    },
    CUSTOMER_KEY,
  );
  return { ...golden, receipt, mandate };
}

describe("a receipt that makes no identity claim", () => {
  it("is reported as not applicable, not as a pass", () => {
    const result = checkAgentIdentity(goldenInput());
    expect(result.ok).toBe(true);
    expect(result.applicable).toBe(false);
    expect(result.detail).toContain("agency-x-agent");
    expect(result.detail).toContain("handle");
  });

  it("leaves the run verified, and says which check had nothing to do", async () => {
    const outcome = await verify(
      {
        topicId: GOLDEN_TOPIC,
        receiptPath: new URL("./golden/receipt.json", import.meta.url).pathname,
        mandatePath: new URL("./golden/mandate.json", import.meta.url).pathname,
      },
      offlineDeps(),
    );
    expect(outcome.code).toBe(EXIT_OK);
    expect(outcome.output).toContain("N/A");
    expect(outcome.output).toContain("applicable checks passed");
    expect(outcome.output).toContain(`had nothing to check: ${CHECK_IDENTITY}`);
  });
});

describe("a receipt signed by the agent it names", () => {
  it("passes, naming the identifier and the key", () => {
    const result = checkAgentIdentity(identifiedInput());
    expect(result).toMatchObject({ name: CHECK_IDENTITY, ok: true });
    expect(result.applicable).toBeUndefined();
    expect(result.detail).toContain("uaid:did:");
    expect(result.detail).toContain("is the key that signed this receipt");
  });

  it("runs in its place among the other checks", () => {
    const results = runChecks(identifiedInput());
    expect(results.map(result => result.name)).toEqual([...CHECK_NAMES]);
    expect(results[1]?.name).toBe(CHECK_IDENTITY);
    expect(results[1]?.ok).toBe(true);
  });

  it("passes without the work order, which is optional evidence", () => {
    const input = identifiedInput();
    delete input.mandate;
    expect(checkAgentIdentity(input).ok).toBe(true);
  });
});

describe("a receipt whose identifier does not hold", () => {
  it("fails when the identifier names a different key", () => {
    const impostor = uaidFromPublicKey(publicKeyHex("cc".repeat(32)), { registry: "self" });
    const result = checkAgentIdentity(identifiedInput({ receiptFrom: impostor }));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("is signed by");
    expect(result.detail).toContain("names");
  });

  it("fails when the identifier is malformed", () => {
    const result = checkAgentIdentity(
      identifiedInput({ receiptFrom: `uaid:did:${didKeyFromPublicKey(publicKeyHex(CONTRACTOR_KEY))}` }),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("uid parameter is required");
  });

  it("fails when the receipt is addressed to something calling itself an identifier", () => {
    const result = checkAgentIdentity(identifiedInput({ receiptTo: "uaid:did:;uid=0" }));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not a well-formed identifier");
  });

  it("fails when the work order was signed by someone other than the agent it names", () => {
    const wrong = uaidFromPublicKey(publicKeyHex("dd".repeat(32)), { registry: "self" });
    const input = identifiedInput();
    input.mandate = signEnvelope<Mandate>(
      {
        schema: "mandate.v1",
        from: wrong,
        to: CONTRACTOR_UAID,
        thread_id: input.mandate!.thread_id,
        issued_at: input.mandate!.issued_at,
        data: input.mandate!.data,
      },
      CUSTOMER_KEY,
    );
    input.receipt = signEnvelope<PaymentReceipt>(
      { ...stripSignature(input.receipt), to: wrong },
      CONTRACTOR_KEY,
    );
    const result = checkAgentIdentity(input);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("was signed by");
  });

  it("fails when the receipt answers an agent other than the one that ordered", () => {
    const result = checkAgentIdentity(identifiedInput({ mandateFrom: "client-y-agent" }));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("addressed to");
    expect(result.detail).toContain("client-y-agent");
  });
});

describe("an identifier this verifier cannot resolve", () => {
  it("is reported as not applicable, with the reason", () => {
    for (const identifier of ["uaid:aid:5JqkPmC6;uid=0;registry=hol", "uaid:did:web:example.com;uid=0"]) {
      const result = checkAgentIdentity(identifiedInput({ receiptFrom: identifier }));
      expect(result.applicable, identifier).toBe(false);
      expect(result.ok, identifier).toBe(true);
      expect(result.detail).toContain("public mirror node");
    }
  });
});

describe("the report", () => {
  it("prints N/A rather than PASS for a check that decided nothing", () => {
    const table = renderTable([
      { name: CHECK_IDENTITY, ok: true, applicable: false, detail: "no claim" },
      { name: "receipt signature", ok: true, detail: "signed" },
    ]);
    expect(table).toMatch(/N\/A.*agent identity/s);
    expect(table).toMatch(/PASS.*receipt signature/s);
  });
});

/**
 * An envelope without its signature, ready to be signed again.
 *
 * @param envelope - The signed envelope
 * @returns Its body
 */
function stripSignature<T>(envelope: Envelope<T>): Omit<Envelope<T>, "sig"> {
  const { sig, ...body } = envelope;
  void sig;
  return body;
}
