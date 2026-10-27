function classifyGetSelf(result) {
  if (result.ok) {
    const data = result.data;
    if (data && typeof data === "object") {
      const d = data;
      const owner = d.owner;
      const ownerUserId = owner && typeof owner === "object" ? owner.user_id : void 0;
      const principal = typeof ownerUserId === "string" && ownerUserId || (typeof d.owner_id === "string" ? d.owner_id : "");
      if (principal) {
        const mxid = typeof d.mxid === "string" && d.mxid || typeof d.user_id === "string" && d.user_id || "";
        const ccRoomId = typeof d.cc_room_id === "string" ? d.cc_room_id : void 0;
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
function isFirstContact(instructions) {
  return typeof instructions === "string" && instructions.includes("First contact:");
}
function signedMediaOffered(toolNames) {
  return !!toolNames?.has("get_media_download_url") && !!toolNames.has("create_media_upload");
}
function attachmentsGuidance(signedMedia) {
  const turn = "Attachments: files people send you on Filament arrive with their message as local files (the `[media attached: \u2026]` lines); open those with your own tools, and don't download them again. To send a file with your reply, save it under your workspace and put a line `MEDIA:<path>` in the reply: it is attached to the message.";
  const tools = signedMedia ? " For a file you find with a read tool (a message's `media` block), call filament_get_media_download_url and curl its download_url to a local file. To attach a file to a message you post with a filament_ tool, or to use it as set_profile's image, call filament_create_media_upload, curl the file to its upload_url, and pass the returned mxc_url." : " This Filament server has no way for you to attach a new file to a message you post with a filament_ tool: send it as your reply instead.";
  return `${turn}${tools} You never need a token for files: never look for one in the plugin's files or config.`;
}
function turnInstructions(instructions, opts = {}) {
  const attachments = attachmentsGuidance(opts.signedMedia === true);
  const paragraphs = (typeof instructions === "string" ? instructions.split("\n\n") : []).filter((paragraph) => !paragraph.trimStart().startsWith("First contact:")).map(
    (paragraph) => paragraph.trimStart().startsWith("Attachments:") ? attachments : paragraph
  ).filter((paragraph) => paragraph.trim());
  if (!paragraphs.includes(attachments)) paragraphs.push(attachments);
  return paragraphs.join("\n\n").trim();
}
export {
  attachmentsGuidance,
  classifyGetSelf,
  isFirstContact,
  signedMediaOffered,
  turnInstructions
};
