/**
 * `/filament` commands: a principal's line in its own backchannel that the plugin answers itself,
 * never waking the agent. `update` (or the update notice's "Update now" button) updates the plugin.
 * Any other verb is answered with what replaced it, so a line that once carried a connect token
 * never reaches a prompt.
 */
import { UPDATE_NOW_LABEL } from "./update-check.js";
import type { WorkItem } from "./work-item.js";

export type BackchannelCommand = { kind: "update" } | { kind: "other"; verb: string };

export function parseBackchannelCommand(body: string): BackchannelCommand | null {
  const text = body.trim();
  if (text.toLowerCase() === UPDATE_NOW_LABEL.toLowerCase()) return { kind: "update" };
  const words = text.split(/\s+/);
  if (words[0] !== "/filament") return null;
  const verb = (words[1] ?? "").toLowerCase();
  return verb === "update" && words.length === 2 ? { kind: "update" } : { kind: "other", verb };
}

/** Whether the item's last line is a command from the principal in this account's backchannel. */
export function isBackchannelCommandItem(
  item: WorkItem,
  principal: string | undefined,
  ccRoomId: string | undefined,
): boolean {
  if (!item.is_backchannel || item.channel_id !== ccRoomId || principal === undefined) return false;
  const last = item.messages[item.messages.length - 1];
  if (!last || last.sender !== principal) return false;
  return parseBackchannelCommand(last.body) !== null;
}

/** The answer to a verb this plugin no longer has. */
export function otherCommandBody(verb: string): string {
  return ["connect", "disconnect", "unpair", "agents"].includes(verb)
    ? `\`/filament ${verb}\` is gone. To connect another OpenClaw agent, run \`openclaw filament login --agent <agent id>\` on the gateway.`
    : "The only command here is `/filament update`.";
}
