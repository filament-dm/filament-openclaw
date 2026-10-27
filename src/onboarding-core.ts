import type { ToolCallResult } from "./mcp-client.js";

export type OnboardingStatus = "finalized" | "not_finalized" | "auth_failed" | "transient";

export interface ResolvedIdentity {
  mxid: string;
  principal: string;
  ccRoomId?: string;
}

export interface OnboardingDecision {
  status: OnboardingStatus;
  identity?: ResolvedIdentity;
}

/** An agent without an owner, or `-32002` (reserved), is not finalized yet. */
export function classifyGetSelf(result: ToolCallResult): OnboardingDecision {
  if (result.ok) {
    const data = result.data;
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      const owner = d.owner;
      const ownerUserId =
        owner && typeof owner === "object" ? (owner as { user_id?: unknown }).user_id : undefined;
      const principal =
        (typeof ownerUserId === "string" && ownerUserId) ||
        (typeof d.owner_id === "string" ? d.owner_id : "");
      if (principal) {
        const mxid =
          (typeof d.mxid === "string" && d.mxid) ||
          (typeof d.user_id === "string" && d.user_id) ||
          "";
        const ccRoomId = typeof d.cc_room_id === "string" ? d.cc_room_id : undefined;
        return { status: "finalized", identity: { mxid, principal, ccRoomId } };
      }
    }
    return { status: "not_finalized" };
  }

  const code = result.error?.code;
  if (result.httpStatus === 401 || result.httpStatus === 403 || code === -32001) {
    return { status: "auth_failed" };
  }
  if (code === -32002) {
    return { status: "not_finalized" };
  }
  return { status: "transient" };
}

/** The server asks the agent to greet on connect through its `initialize` instructions. */
export function isFirstContact(instructions: string | null | undefined): boolean {
  return typeof instructions === "string" && instructions.includes("First contact:");
}

/** The tools that hand the agent short-lived URLs for media, so its shell moves the bytes. */
export function signedMediaOffered(toolNames: ReadonlySet<string> | null | undefined): boolean {
  return !!toolNames?.has("get_media_download_url") && !!toolNames.has("create_media_upload");
}

/**
 * How files move for an OpenClaw agent. The server's own paragraph tells a bare MCP client to fetch
 * every attachment through tools; here the gateway already saved the turn's files, and sends the
 * files a reply names, so the tools are only for files outside the turn.
 */
export function attachmentsGuidance(signedMedia: boolean): string {
  const turn =
    "Attachments: files people send you on Filament arrive with their message as local files " +
    "(the `[media attached: …]` lines); open those with your own tools, and don't download them " +
    "again. To send a file with your reply, save it under your workspace and put a line " +
    "`MEDIA:<path>` in the reply: it is attached to the message.";
  const tools = signedMedia
    ? " For a file you find with a read tool (a message's `media` block), call " +
      "filament_get_media_download_url and curl its download_url to a local file. To attach a " +
      "file to a message you post with a filament_ tool, or to use it as set_profile's image, " +
      "call filament_create_media_upload, curl the file to its upload_url, and pass the returned " +
      "mxc_url."
    : " This Filament server has no way for you to attach a new file to a message you post with " +
      "a filament_ tool: send it as your reply instead.";
  return `${turn}${tools} You never need a token for files: never look for one in the plugin's files or config.`;
}

/**
 * The server's `initialize` instructions as standing context for every turn. They are read once
 * per connect, so the one-shot "First contact:" paragraph is left out: repeated on each turn it
 * would have the agent greet its principal again and again. The server's "Attachments:" paragraph
 * gives way to `attachmentsGuidance`, which is there even when the server sent none.
 */
export function turnInstructions(
  instructions: string | null | undefined,
  opts: { signedMedia?: boolean } = {},
): string {
  const attachments = attachmentsGuidance(opts.signedMedia === true);
  const paragraphs = (typeof instructions === "string" ? instructions.split("\n\n") : [])
    .filter((paragraph) => !paragraph.trimStart().startsWith("First contact:"))
    .map((paragraph) =>
      paragraph.trimStart().startsWith("Attachments:") ? attachments : paragraph,
    )
    .filter((paragraph) => paragraph.trim());
  if (!paragraphs.includes(attachments)) paragraphs.push(attachments);
  return paragraphs.join("\n\n").trim();
}
