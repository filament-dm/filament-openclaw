/** A fake Filament OAuth server for tests: answers `fetch` from a table, /token from a queue. */
import type { Fetch } from "../oauth-login.js";

export const MCP = "https://api.example/mcp/agents";
export const ISSUER = "https://api.example/mcp/agents/oauth";

/** A status and JSON body, a raw body (status 200), or an error `fetch` throws. */
export type Answer = [status: number, doc: unknown] | string | Error;

export interface Call {
  url: string;
  method: string;
  form?: Record<string, string>;
  body?: Record<string, unknown>;
}

export function server(device = true): Record<string, Answer> {
  return {
    "https://api.example/.well-known/oauth-protected-resource/mcp/agents": [
      200,
      { resource: MCP, authorization_servers: [ISSUER] },
    ],
    "https://api.example/.well-known/oauth-authorization-server/mcp/agents/oauth": [
      200,
      {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        ...(device ? { device_authorization_endpoint: `${ISSUER}/device_authorization` } : {}),
      },
    ],
    [`${ISSUER}/register`]: [201, { client_id: "client-1" }],
    [`${ISSUER}/device_authorization`]: [
      200,
      {
        device_code: "dev_1",
        user_code: "BCDF-GHJK",
        verification_uri: `${ISSUER}/device`,
        verification_uri_complete: `${ISSUER}/device?user_code=BCDF-GHJK`,
        expires_in: 600,
        interval: 5,
      },
    ],
  };
}

/** Answers from a table; /token answers come from a queue. */
export function fakeHttp(routes: Record<string, Answer>, tokenAnswers: Answer[] = []) {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const isForm = String(new Headers(init?.headers).get("content-type")).includes("form");
    calls.push({
      url,
      method: init?.method ?? "GET",
      ...(raw && isForm ? { form: Object.fromEntries(new URLSearchParams(raw)) } : {}),
      ...(raw && !isForm ? { body: JSON.parse(raw) } : {}),
    });
    const answer = url === `${ISSUER}/token` ? tokenAnswers.shift() : routes[url];
    if (answer === undefined) return new Response("{}", { status: 404 });
    if (answer instanceof Error) throw answer;
    if (typeof answer === "string") return new Response(answer, { status: 200 });
    return new Response(JSON.stringify(answer[1]), { status: answer[0] });
  };
  return { fetch: fetchImpl, calls };
}
