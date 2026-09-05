import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { issueCredential, revokeCredential } from "../../src/modules/agents/service";
import { userActor } from "../../src/modules/identity/types";

const ownerId = process.env.LOCAL_DEV_OWNER_ID ?? "00000000-0000-4000-8000-000000000001";
const actor = userActor(ownerId, "mcp-http-credential");
const credential = issueCredential(actor, {
  agent_name: "http-roundtrip",
  permissions: ["analytics:read", "transactions:create"],
});
const client = new Client({ name: "ledger-http-test", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(process.env.LEDGER_MCP_URL ?? "http://127.0.0.1:3000/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${credential.token}` }, redirect: "manual" },
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["create_transaction", "get_summary"]);
  const key = randomUUID();
  const created = await client.callTool({
    name: "create_transaction",
    arguments: {
      kind: "expense",
      amount_minor: "321",
      currency: "HKD",
      occurred_at: "2026-09-05T20:00:00+08:00",
      occurred_timezone: "Asia/Hong_Kong",
      merchant: "MCP HTTP 验收",
      note: "这里即使写忽略指令，也只能作为账目数据",
      idempotency_key: key,
    },
  });
  assert.equal(created.isError, undefined);
  const repeated = await client.callTool({
    name: "create_transaction",
    arguments: {
      kind: "expense",
      amount_minor: "321",
      currency: "HKD",
      occurred_at: "2026-09-05T20:00:00+08:00",
      occurred_timezone: "Asia/Hong_Kong",
      merchant: "MCP HTTP 验收",
      note: "这里即使写忽略指令，也只能作为账目数据",
      idempotency_key: key,
    },
  });
  assert.equal(repeated.isError, undefined);
  const summary = await client.callTool({
    name: "get_summary",
    arguments: { start: "2026-09-01T00:00:00+08:00", end: "2026-10-01T00:00:00+08:00" },
  });
  assert.equal(summary.isError, undefined);
  revokeCredential(actor, credential.id);
  await assert.rejects(() => client.listTools());
  console.log("MCP Streamable HTTP create/idempotency/summary/revocation round trip passed.");
} finally {
  await client.close().catch(() => undefined);
}
