import { UPDATE_NOW_LABEL } from "./update-check.js";
function parseBackchannelCommand(body) {
  const text = body.trim();
  if (text.toLowerCase() === UPDATE_NOW_LABEL.toLowerCase()) return { kind: "update" };
  const words = text.split(/\s+/);
  if (words[0] !== "/filament") return null;
  const verb = (words[1] ?? "").toLowerCase();
  return verb === "update" && words.length === 2 ? { kind: "update" } : { kind: "other", verb };
}
function isBackchannelCommandItem(item, principal, ccRoomId) {
  if (!item.is_backchannel || item.channel_id !== ccRoomId || principal === void 0) return false;
  const last = item.messages[item.messages.length - 1];
  if (!last || last.sender !== principal) return false;
  return parseBackchannelCommand(last.body) !== null;
}
function otherCommandBody(verb) {
  return ["connect", "disconnect", "unpair", "agents"].includes(verb) ? `\`/filament ${verb}\` is gone. To connect another OpenClaw agent, run \`openclaw filament login --agent <agent id>\` on the gateway.` : "The only command here is `/filament update`.";
}
export {
  isBackchannelCommandItem,
  otherCommandBody,
  parseBackchannelCommand
};
