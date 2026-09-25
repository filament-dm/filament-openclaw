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
export {
  classifyGetSelf,
  isFirstContact
};
//# sourceMappingURL=onboarding-core.js.map
