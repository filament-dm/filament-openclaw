function turnPeerKind(item) {
  return item.is_backchannel ? "direct" : "group";
}
function turnWasMentioned(item) {
  if (item.is_backchannel) return void 0;
  const fromPeople = item.messages.filter((m) => m.sender_is_agent !== true);
  if (fromPeople.length === 0) return false;
  const judged = fromPeople.filter((m) => typeof m.reply_expected === "boolean");
  if (judged.length > 0) return judged.some((m) => m.reply_expected === true);
  return item.is_direct === true || fromPeople.some((m) => m.is_mention === true);
}
const ATTACHMENT_ONLY_BODY = "(an attachment, with no text)";
export {
  ATTACHMENT_ONLY_BODY,
  turnPeerKind,
  turnWasMentioned
};
