/**
 * The `collect` tool against a local stand-in contractor: pays the balance,
 * stores the receipt, and reports both legs with the amounts the signed
 * `payment.v1` profile carries.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Story } from "../../customer/cli";
import type { CustomerConfig } from "../../customer/wallet";
import type { ToolDeps } from "../../mcp/server";
import { runCollectTool, runOrderTool } from "../../mcp/server";
import { customerIdentities, startStandInContractor } from "./helpers";
import type { StandInContractor } from "./helpers";

const STORY: Story = {
  story_ref: "story-9002",
  story_url: "https://client-y.example.com/board/story/9002",
  title: "Add a settings toggle for compact mode",
  acceptance: ["A toggle exists in Settings", "The list re-renders compact within one frame"],
  frame: "Client Y web app; epic 'Preferences'",
};

let contractor: StandInContractor;
let outDir: string;
let deps: ToolDeps;

beforeEach(async () => {
  contractor = await startStandInContractor();
  outDir = mkdtempSync(join(tmpdir(), "mcp-collect-"));
  const identities = customerIdentities();
  const config: CustomerConfig = {
    signing: identities.signing,
    payment: identities.payment,
    contractorUrl: contractor.url,
    outDir,
  };
  deps = { config: () => config, verify: () => Promise.reject(new Error("not used by this suite")) };
});

afterEach(async () => {
  await contractor.close();
  rmSync(outDir, { recursive: true, force: true });
});

/**
 * Places an order and returns its mandate id, the way a test that only cares
 * about collecting needs it.
 *
 * @returns The mandate id of the placed order
 */
async function placeOrder(): Promise<string> {
  const result = (await runOrderTool({ story: STORY }, deps)) as CallToolResult;
  return (result.structuredContent as { mandate_id: string }).mandate_id;
}

describe("runCollectTool", () => {
  it("returns 409-shaped guidance as a tool error before delivery", async () => {
    const mandateId = await placeOrder();
    const result = (await runCollectTool({ mandateId }, deps)) as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toMatch(/does not exist yet|409/i);
  });

  it("pays the balance and returns both legs with their amounts once delivered", async () => {
    const mandateId = await placeOrder();
    contractor.deliver(mandateId);

    const result = (await runCollectTool({ mandateId }, deps)) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      mandate_id: string;
      payments: {
        intake: { tinybars: number; transaction_id: string; hashscan_url: string };
        balance?: { tinybars: number; transaction_id: string; hashscan_url: string };
      };
      deliverable?: { pr_url: string; staging_url: string; notion_status: string };
      artifact: string;
    };

    expect(payload.mandate_id).toBe(mandateId);
    expect(payload.payments.intake.tinybars).toBeGreaterThan(0);
    expect(payload.payments.balance?.tinybars).toBeGreaterThan(0);
    expect(payload.payments.balance?.transaction_id).toMatch(/^0\.0\.\d+@\d+\.\d+$/);
    expect(payload.deliverable?.pr_url).toContain("https://");

    const saved = JSON.parse(readFileSync(payload.artifact, "utf8")) as { data: { kind: string } };
    expect(saved.data.kind).toBe("delivered");
  });

  it("releases the same receipt without a second charge when collected twice", async () => {
    const mandateId = await placeOrder();
    contractor.deliver(mandateId);

    const first = (await runCollectTool({ mandateId }, deps)) as CallToolResult;
    const second = (await runCollectTool({ mandateId }, deps)) as CallToolResult;

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    const firstPayload = first.structuredContent as { payments: { balance?: { transaction_id: string } } };
    const secondPayload = second.structuredContent as { payments: { balance?: { transaction_id: string } } };
    expect(secondPayload.payments.balance?.transaction_id).toBe(firstPayload.payments.balance?.transaction_id);
  });

  it("returns a tool error for an order id the contractor has never seen", async () => {
    const result = (await runCollectTool({ mandateId: "no-such-order" }, deps)) as CallToolResult;
    expect(result.isError).toBe(true);
  });
});
