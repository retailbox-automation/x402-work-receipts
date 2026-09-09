/**
 * The MCP server itself, over the SDK's in-memory transport: what tools it
 * lists, and that `verify` runs end to end through a real MCP client — no
 * process boundary, no stdio framing, but the same protocol messages a real
 * client would send.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnchorEntry } from "../../anchor/records";
import { toMirrorTxId } from "../../anchor/records";
import { CHECK_NAMES } from "../../verifier/checks";
import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, verify } from "../../verifier/cli";
import type { VerifyDeps } from "../../verifier/cli";
import type { MirrorTransaction } from "../../verifier/mirror";
import { createMcpServer, type ToolDeps } from "../../mcp/server";
import {
  GOLDEN_TOPIC,
  anchorsFrom,
  goldenMandate,
  goldenReceipt,
  goldenTopicPage,
  goldenTransactions,
} from "../verifier/helpers";
import type { TopicMessagePage } from "../verifier/helpers";

/** Mirror readers backed by the recorded golden snapshot — never the network. */
function offlineDeps(page: TopicMessagePage = goldenTopicPage()): VerifyDeps {
  const anchors = anchorsFrom(page);
  const transactions = goldenTransactions();
  return {
    readAnchors: async (): Promise<AnchorEntry[]> => anchors,
    readTransaction: async (id: string): Promise<MirrorTransaction | null> =>
      transactions.get(toMirrorTxId(id)) ?? null,
  };
}

/** Test dependencies: config is never called by these tests; verify is offline. */
function testDeps(deps: VerifyDeps = offlineDeps()): ToolDeps {
  return {
    config: () => {
      throw new Error("config() should not be called by a test that never places or collects an order");
    },
    verify: request => verify(request, deps),
  };
}

/** Absolute path of a fixture under `tests/verifier`, as a client would pass one. */
function verifierFixture(relativePath: string): string {
  return new URL(`../verifier/${relativePath}`, import.meta.url).pathname;
}

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

/**
 * Connects a real MCP client to a server built from the given dependencies,
 * over a linked pair of in-memory transports.
 *
 * @param deps - Tool dependencies for the server under test
 * @returns The connected client
 */
async function connect(deps: ToolDeps): Promise<Client> {
  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("tool listing", () => {
  it("lists order, collect and verify with descriptions", async () => {
    const c = await connect(testDeps());
    const { tools } = await c.listTools();
    const names = tools.map(tool => tool.name).sort();
    expect(names).toEqual(["collect", "order", "verify"]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
  });
});

describe("verify tool, called over MCP", () => {
  it("passes the golden receipt", async () => {
    const c = await connect(testDeps());
    const result = (await c.callTool({
      name: "verify",
      arguments: {
        topic: GOLDEN_TOPIC,
        receiptPath: verifierFixture("golden/receipt.json"),
        mandatePath: verifierFixture("golden/mandate.json"),
      },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as { verdict: string; exit_code: number; checks: unknown[] };
    expect(payload.verdict).toBe("PASS");
    expect(payload.exit_code).toBe(EXIT_OK);
    expect(payload.checks).toHaveLength(CHECK_NAMES.length);
    expect((result.content?.[0] as { text: string }).text).toContain("PASS");
  });

  it("fails a tampered receipt, naming the check that broke", async () => {
    const c = await connect(testDeps());
    const result = (await c.callTool({
      name: "verify",
      arguments: {
        topic: GOLDEN_TOPIC,
        receiptPath: verifierFixture("tampered/wrong-payee.json"),
        mandatePath: verifierFixture("golden/mandate.json"),
      },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      verdict: string;
      exit_code: number;
      checks: { name: string; ok: boolean }[];
    };
    expect(payload.verdict).toBe("FAIL");
    expect(payload.exit_code).toBe(EXIT_FAILED);
    expect(payload.checks.some(check => check.name === "payments on ledger" && !check.ok)).toBe(true);
  });

  it("verifies a receipt given as inline JSON, not a file", async () => {
    const c = await connect(testDeps());

    const result = (await c.callTool({
      name: "verify",
      arguments: { topic: GOLDEN_TOPIC, receipt: goldenReceipt(), mandate: goldenMandate() },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { verdict: string }).verdict).toBe("PASS");
  });

  it("reports ERROR, not a thrown error, when the mirror node cannot be read", async () => {
    const c = await connect(
      testDeps({
        readAnchors: async () => {
          throw new Error("mirror node unreachable");
        },
        readTransaction: async () => null,
      }),
    );

    const result = (await c.callTool({
      name: "verify",
      arguments: { topic: GOLDEN_TOPIC, receiptPath: verifierFixture("golden/receipt.json") },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as { verdict: string; exit_code: number; checks: unknown[] };
    expect(payload.verdict).toBe("ERROR");
    expect(payload.exit_code).toBe(EXIT_ERROR);
    expect(payload.checks).toEqual([]);
  });

  it("returns a tool error when both receipt and receiptPath are given", async () => {
    const c = await connect(testDeps());
    const result = (await c.callTool({
      name: "verify",
      arguments: {
        topic: GOLDEN_TOPIC,
        receiptPath: verifierFixture("golden/receipt.json"),
        receipt: { schema: "receipt.v1+payment.v1" },
      },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toMatch(/exactly one/);
  });

  it("returns a tool error, not a crash, for an unrelated bad input", async () => {
    const c = await connect(testDeps());
    const result = (await c.callTool({
      name: "verify",
      arguments: { topic: GOLDEN_TOPIC, receiptPath: "/does/not/exist.json" },
    })) as CallToolResult;

    // The verifier itself answers "could not read" as an ERROR outcome, not a
    // throw — this asserts the tool still returns cleanly on top of that.
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { verdict: string }).verdict).toBe("ERROR");
  });
});
