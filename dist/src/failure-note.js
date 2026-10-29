import { REPLIED_BACKCHANNEL, REPLIED_UNKNOWN_ROOM } from "./filament-tools.js";
const MAX_REASON_CHARS = 300;
function failureNote(item, result) {
  const raw = (result.errorReplyText ?? result.errorDetail ?? "").trim() || "no detail";
  const reason = raw.length > MAX_REASON_CHARS ? `${raw.slice(0, MAX_REASON_CHARS)}\u2026` : raw;
  const where = item.is_backchannel ? "your last message" : item.channel_name ? `a message in ${item.channel_name}` : "a message in one of my channels";
  return `OpenClaw ended my turn on ${where} with an error, so I posted nothing there. OpenClaw said: ${reason}`;
}
function answeredWithTools(item, result) {
  if (result.reacted) return true;
  const { repliedTo } = result;
  if (repliedTo.has(REPLIED_UNKNOWN_ROOM) || repliedTo.has(item.channel_id)) return true;
  return item.is_backchannel === true && repliedTo.has(REPLIED_BACKCHANNEL);
}
async function notifyPrincipalOfFailure(client, item, result, opts) {
  try {
    const res = await client.callTool(
      "message_principal",
      { markdown_body: failureNote(item, result) },
      { signal: opts.signal }
    );
    if (!res.ok) opts.log(`filament: failure note not sent (${res.error?.message ?? "?"})`);
    return res.ok;
  } catch (error) {
    opts.log(`filament: failure note not sent: ${String(error)}`);
    return false;
  }
}
export {
  answeredWithTools,
  failureNote,
  notifyPrincipalOfFailure
};
