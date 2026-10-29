/**
 * Attachments between Filament and an OpenClaw turn, moved by the gateway so their bytes never
 * pass through the model: a message's attachment is fetched from a `get_media_download_url` URL
 * where the server has that tool (else the bearer `/media` side-channel), and a reply's is sent
 * through the bearer `/upload` side-channel.
 */
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";

import type { CallOptions } from "./mcp-client.js";
import type { WorkMessage } from "./work-item.js";

/** Per file, both ways. The server's own upload cap is larger (50 MB). */
export const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
/** Attachments fetched for one turn; a gallery past this is cut, and the log says so. */
export const MAX_INBOUND_MEDIA = 8;

/** One fetched attachment, saved where the turn can read it. */
export interface InboundMedia {
  path: string;
  contentType?: string;
  messageId: string;
}

export interface OutboundAttachment {
  mxc_url: string;
  filename?: string;
}

interface MediaClient {
  downloadMedia(
    mxcUrl: string,
    maxBytes: number,
    opts?: CallOptions & { messageId?: string },
  ): Promise<{ bytes: Buffer; contentType: string | null }>;
  uploadMedia(
    bytes: Uint8Array,
    contentType: string,
    filename: string | undefined,
    opts?: CallOptions,
  ): Promise<string>;
}

export interface InboundMediaDeps {
  save?: (
    bytes: Buffer,
    contentType: string | undefined,
    filename: string | undefined,
  ) => Promise<{ path: string; contentType?: string }>;
}

/**
 * Downloads the attachments on an item's messages and saves them for the turn. A failure skips
 * that attachment: the message still reaches the agent, with its caption or the placeholder body.
 */
export async function fetchInboundMedia(
  client: MediaClient,
  messages: readonly WorkMessage[],
  opts: { log: (message: string) => void; signal?: AbortSignal },
  deps: InboundMediaDeps = {},
): Promise<InboundMedia[]> {
  const save =
    deps.save ??
    ((bytes, contentType, filename) =>
      saveMediaBuffer(bytes, contentType, "inbound", MEDIA_MAX_BYTES, filename));
  const wanted = messages.flatMap((m) => (m.media ?? []).map((media) => ({ m, media })));
  if (wanted.length > MAX_INBOUND_MEDIA) {
    opts.log(
      `filament-media: ${wanted.length} attachments; fetching the first ${MAX_INBOUND_MEDIA}`,
    );
  }
  const saved: InboundMedia[] = [];
  for (const { m, media } of wanted.slice(0, MAX_INBOUND_MEDIA)) {
    if (opts.signal?.aborted) break;
    if (media.size !== undefined && media.size > MEDIA_MAX_BYTES) {
      opts.log(`filament-media: skipping ${media.mxc_url}: ${media.size} bytes is over the limit`);
      continue;
    }
    try {
      const { bytes, contentType } = await client.downloadMedia(media.mxc_url, MEDIA_MAX_BYTES, {
        signal: opts.signal,
        messageId: m.event_id,
      });
      const file = await save(bytes, contentType ?? media.mimetype, media.filename);
      saved.push({
        path: file.path,
        contentType: file.contentType ?? contentType ?? media.mimetype,
        messageId: m.event_id,
      });
    } catch (error) {
      opts.log(`filament-media: could not fetch ${media.mxc_url}: ${String(error)}`);
    }
  }
  return saved;
}

export interface OutboundMediaDeps {
  load?: (url: string) => Promise<{ buffer: Buffer; contentType?: string; fileName?: string }>;
}

/**
 * Loads the media a turn's reply names (a local path inside the agent's media roots, or a URL)
 * and uploads it. A failure drops that attachment and the reply still goes out.
 */
export async function uploadOutboundMedia(
  client: MediaClient,
  mediaUrls: readonly string[],
  opts: {
    mediaLocalRoots: readonly string[];
    log: (message: string) => void;
    signal?: AbortSignal;
  },
  deps: OutboundMediaDeps = {},
): Promise<OutboundAttachment[]> {
  const load =
    deps.load ??
    ((url: string) =>
      loadOutboundMediaFromUrl(url, {
        maxBytes: MEDIA_MAX_BYTES,
        mediaLocalRoots: opts.mediaLocalRoots,
      }));
  const attachments: OutboundAttachment[] = [];
  for (const url of mediaUrls) {
    if (opts.signal?.aborted) break;
    try {
      const media = await load(url);
      const mxcUrl = await client.uploadMedia(
        media.buffer,
        media.contentType ?? "application/octet-stream",
        media.fileName,
        { signal: opts.signal },
      );
      attachments.push({
        mxc_url: mxcUrl,
        ...(media.fileName ? { filename: media.fileName } : {}),
      });
    } catch (error) {
      opts.log(`filament-media: could not send ${url}: ${String(error)}`);
    }
  }
  return attachments;
}
