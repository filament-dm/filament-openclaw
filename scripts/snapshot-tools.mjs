#!/usr/bin/env node
/**
 * Regenerate `src/filament-tools.snapshot.json`: a static array of
 * `{name, description, inputSchema, annotations}` for every tool the live
 * Filament MCP server advertises, minus the tools this plugin never
 * registers (`poll_work`, `register_push_token`, `list_push_tokens` — see
 * `src/filament-tools.ts`'s `EXCLUDED_TOOLS`). `annotations` (specifically
 * `readOnlyHint`) is kept even though it's not part of the minimal spec,
 * because `classifyToolTier` needs it to pick the read/ring0/write gate at
 * registration time now that `tools/list` is no longer fetched before a
 * tool is registered.
 *
 * Talks to the server directly with `initialize` + `tools/list`, mirroring
 * the JSON-RPC request shape `src/mcp-client.ts` (`FilamentMcpClient`) uses
 * — this script is intentionally plain Node (no TS build step needed to run
 * it), so the request bodies are hand-mirrored rather than imported.
 *
 * Requires:
 *   FILAMENT_MCP_URL    e.g. http://filament-dev.local:8448/mcp/agents
 *   FILAMENT_MCP_BEARER an already-issued bearer token for that server
 *
 * Usage:
 *   FILAMENT_MCP_URL=... FILAMENT_MCP_BEARER=... npm run snapshot:tools
 *
 * When no bearer is available (e.g. an agent session with no live gateway
 * to mint one from), the snapshot can instead be produced by reading the
 * tool registry straight out of the `synapse` source — see the header of
 * `/private/tmp/.../scratchpad/dump_tool_schemas.py` (not part of this repo;
 * a throwaway script) for that path. Whichever way produced the *committed*
 * file should be noted in the commit message.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const MCP_PROTOCOL_VERSION = "2025-03-26";

const EXCLUDED_TOOLS = new Set(["poll_work", "register_push_token", "list_push_tokens"]);

const OUTPUT_PATH = fileURLToPath(
  new URL("../src/filament-tools.snapshot.json", import.meta.url),
);

async function postJsonRpc(url, bearer, sessionIdRef, body, expectJson) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
      ...(sessionIdRef.id ? { "mcp-session-id": sessionIdRef.id } : {}),
    },
    body: JSON.stringify(body),
  });
  const headerSid = response.headers.get("mcp-session-id");
  if (headerSid) sessionIdRef.id = headerSid;
  if (!expectJson || response.status === 204) return { status: response.status, json: null };
  const json = await response.json();
  return { status: response.status, json };
}

async function main() {
  const mcpUrl = process.env.FILAMENT_MCP_URL;
  const bearer = process.env.FILAMENT_MCP_BEARER;
  if (!mcpUrl || !bearer) {
    console.error(
      "snapshot-tools: FILAMENT_MCP_URL and FILAMENT_MCP_BEARER must both be set.\n" +
        "No bearer available? Generate the snapshot from synapse source instead — see this " +
        "script's header comment.",
    );
    process.exitCode = 1;
    return;
  }

  const sessionIdRef = { id: null };
  let nextId = 1;

  const initRes = await postJsonRpc(
    mcpUrl,
    bearer,
    sessionIdRef,
    {
      jsonrpc: "2.0",
      id: nextId++,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "filament-openclaw-snapshot-tools", version: "0.1.0" },
      },
    },
    true,
  );
  if (initRes.json?.error) {
    throw new Error(`initialize failed: ${JSON.stringify(initRes.json.error)}`);
  }

  await postJsonRpc(
    mcpUrl,
    bearer,
    sessionIdRef,
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    false,
  );

  const listRes = await postJsonRpc(
    mcpUrl,
    bearer,
    sessionIdRef,
    { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} },
    true,
  );
  if (listRes.json?.error) {
    throw new Error(`tools/list failed: ${JSON.stringify(listRes.json.error)}`);
  }
  const tools = listRes.json?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("tools/list result missing a tools[] array");
  }

  const snapshot = tools
    .filter((t) => t && typeof t.name === "string" && !EXCLUDED_TOOLS.has(t.name))
    .map((t) => ({
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      annotations: t.annotations && typeof t.annotations === "object" ? t.annotations : {},
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  await writeFile(OUTPUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.error(`snapshot-tools: wrote ${snapshot.length} tool(s) to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(`snapshot-tools: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
