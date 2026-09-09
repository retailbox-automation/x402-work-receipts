/**
 * The `order` tool against a local stand-in contractor. No testnet, no
 * facilitator, no HCS — the payment is a real signed Hedera transfer built by
 * the x402 Hedera scheme (the same client code the real customer agent
 * runs), the network is only the loopback HTTP round trip.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Story } from "../../customer/cli";
import type { CustomerConfig } from "../../customer/wallet";
import type { ToolDeps } from "../../mcp/server";
import { runOrderTool } from "../../mcp/server";
import { customerIdentities, startStandInContractor } from "./helpers";
import type { StandInContractor } from "./helpers";

const STORY: Story = {
  story_ref: "story-9001",
  story_url: "https://client-y.example.com/board/story/9001",
  title: "Group trades by day and show the unread summary",
  acceptance: [
    "Trades are grouped by calendar day with a date header",
    "Each day header shows the number of unread trades",
  ],
  frame: "Client Y web app; epic 'History screen'",
};

let contractor: StandInContractor;
let outDir: string;
let deps: ToolDeps;

beforeEach(async () => {
  contractor = await startStandInContractor();
  outDir = mkdtempSync(join(tmpdir(), "mcp-order-"));
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

describe("runOrderTool", () => {
  it("pays the intake fee, stores the acceptance, and reports what was taken", async () => {
    const result = (await runOrderTool({ story: STORY }, deps)) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      mandate_id: string;
      title: string;
      intake_payment?: { transaction_id: string; hashscan_url: string };
      accepted: { taken: string[]; declined: unknown[] };
      artifacts: { mandate: string; accepted: string };
    };

    expect(payload.title).toBe(STORY.title);
    expect(payload.mandate_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.intake_payment?.transaction_id).toMatch(/^0\.0\.\d+@\d+\.\d+$/);
    expect(payload.intake_payment?.hashscan_url).toContain(payload.intake_payment!.transaction_id);
    expect(payload.accepted.taken).toEqual(STORY.acceptance);
    expect(payload.accepted.declined).toEqual([]);

    const savedMandate = JSON.parse(readFileSync(payload.artifacts.mandate, "utf8")) as { data: { title: string } };
    expect(savedMandate.data.title).toBe(STORY.title);
    expect(contractor.jobs.get(payload.mandate_id)).toBeDefined();

    // Also present at the text block, for a client that only reads text.
    const text = (result.content?.[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual(payload);
  });

  it("reads the story from a file when storyPath is given instead of story", async () => {
    const storyPath = join(outDir, "story.json");
    writeFileSync(storyPath, JSON.stringify(STORY));

    const result = (await runOrderTool({ storyPath }, deps)) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { title: string }).title).toBe(STORY.title);
  });

  it("reports the anchor topic the contractor named", async () => {
    const result = (await runOrderTool({ story: STORY }, deps)) as CallToolResult;
    const payload = result.structuredContent as { anchor?: { topic: string; hashscan_url: string } };
    expect(payload.anchor?.topic).toBeTruthy();
    expect(payload.anchor?.hashscan_url).toContain(payload.anchor?.topic);
  });

  it("returns a tool error, not a throw, when neither story nor storyPath is given", async () => {
    const result = (await runOrderTool({}, deps)) as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toMatch(/exactly one/);
  });

  it("returns a tool error when both story and storyPath are given", async () => {
    const result = (await runOrderTool(
      { story: STORY, storyPath: "/tmp/whatever.json" },
      deps,
    )) as CallToolResult;
    expect(result.isError).toBe(true);
  });

  it("returns a tool error (not a crash) when the contractor is unreachable", async () => {
    await contractor.close();
    const result = (await runOrderTool({ story: STORY }, deps)) as CallToolResult;
    expect(result.isError).toBe(true);
  });
});
