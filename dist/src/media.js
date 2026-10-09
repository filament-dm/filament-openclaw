import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const MAX_INBOUND_MEDIA = 8;
async function fetchInboundMedia(client, messages, opts, deps = {}) {
  const save = deps.save ?? ((bytes, contentType, filename) => saveMediaBuffer(bytes, contentType, "inbound", MEDIA_MAX_BYTES, filename));
  const wanted = messages.flatMap((m) => (m.media ?? []).map((media) => ({ m, media })));
  if (wanted.length > MAX_INBOUND_MEDIA) {
    opts.log(
      `filament-media: ${wanted.length} attachments; fetching the first ${MAX_INBOUND_MEDIA}`
    );
  }
  const saved = [];
  for (const { m, media } of wanted.slice(0, MAX_INBOUND_MEDIA)) {
    if (opts.signal?.aborted) break;
    if (media.size !== void 0 && media.size > MEDIA_MAX_BYTES) {
      opts.log(`filament-media: skipping ${media.mxc_url}: ${media.size} bytes is over the limit`);
      continue;
    }
    try {
      const { bytes, contentType } = await client.downloadMedia(media.mxc_url, MEDIA_MAX_BYTES, {
        signal: opts.signal
      });
      const file = await save(bytes, contentType ?? media.mimetype, media.filename);
      saved.push({
        path: file.path,
        contentType: file.contentType ?? contentType ?? media.mimetype,
        messageId: m.event_id
      });
    } catch (error) {
      opts.log(`filament-media: could not fetch ${media.mxc_url}: ${String(error)}`);
    }
  }
  return saved;
}
async function uploadOutboundMedia(client, mediaUrls, opts, deps = {}) {
  const load = deps.load ?? ((url) => loadOutboundMediaFromUrl(url, {
    maxBytes: MEDIA_MAX_BYTES,
    mediaLocalRoots: opts.mediaLocalRoots
  }));
  const attachments = [];
  for (const url of mediaUrls) {
    if (opts.signal?.aborted) break;
    try {
      const media = await load(url);
      const mxcUrl = await client.uploadMedia(
        media.buffer,
        media.contentType ?? "application/octet-stream",
        media.fileName,
        { signal: opts.signal }
      );
      attachments.push({
        mxc_url: mxcUrl,
        ...media.fileName ? { filename: media.fileName } : {}
      });
    } catch (error) {
      opts.log(`filament-media: could not send ${url}: ${String(error)}`);
    }
  }
  return attachments;
}
export {
  MAX_INBOUND_MEDIA,
  MEDIA_MAX_BYTES,
  fetchInboundMedia,
  uploadOutboundMedia
};
