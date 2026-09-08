/**
 * The deliverable is simulated for the demo, but the links it produces end up
 * inside a signed receipt — so they have to be deterministic (the same order
 * always yields the same links) and valid under `receipt.v1`.
 */
import { describe, expect, it } from "vitest";
import { validateReceipt } from "../../protocol/schemas";
import { parseDeliveryRequest, synthesizeResult } from "../../contractor/work";

describe("synthesizeResult", () => {
  it("returns the same links for the same mandate, every time", () => {
    expect(synthesizeResult("wo-0001")).toEqual(synthesizeResult("wo-0001"));
  });

  it("returns different links for different mandates", () => {
    expect(synthesizeResult("wo-0001").pr_url).not.toBe(synthesizeResult("wo-0002").pr_url);
  });

  it("produces links a receipt.v1 result accepts", () => {
    const result = synthesizeResult("wo-0001");
    const probe = {
      receipt_id: "rc-1",
      kind: "delivered" as const,
      mandate_id: "wo-0001",
      mandate_envelope_hash: "a".repeat(64),
      mandate_anchor: { topic: "0.0.10366000", seq: 1, consensus_ts: "1788600001.000000001" },
      taken: ["something"],
      result,
      issued_at: "2026-09-08T10:00:00.000Z",
      issuer: "agency-x",
    };
    expect(() => validateReceipt(probe)).not.toThrow();
    expect(result.pr_url.startsWith("https://")).toBe(true);
    expect(result.staging_url.startsWith("https://")).toBe(true);
  });

  it("lets the caller override any of the three links", () => {
    const result = synthesizeResult("wo-0001", { notion_status: "In review" });
    expect(result.notion_status).toBe("In review");
    expect(result.pr_url).toBe(synthesizeResult("wo-0001").pr_url);
  });
});

describe("parseDeliveryRequest", () => {
  it("treats an empty body as a request for simulated links", () => {
    expect(parseDeliveryRequest(undefined)).toEqual({});
    expect(parseDeliveryRequest({})).toEqual({});
  });

  it("passes through the three known fields and drops nothing else silently", () => {
    expect(
      parseDeliveryRequest({
        pr_url: "https://git.example.com/agency-x/web/-/merge_requests/9",
        notion_status: "Testing",
      }),
    ).toEqual({
      pr_url: "https://git.example.com/agency-x/web/-/merge_requests/9",
      notion_status: "Testing",
    });
    expect(() => parseDeliveryRequest({ unexpected: "field" })).toThrow(/unexpected/);
  });

  it("refuses a field that is not a string", () => {
    expect(() => parseDeliveryRequest({ pr_url: 42 })).toThrow(/pr_url/);
  });
});
