import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchInboundMedia,
  MAX_INBOUND_MEDIA,
  MEDIA_MAX_BYTES,
  uploadOutboundMedia,
} from "./media.js";
import type { WorkMessage } from "./work-item.js";

function fakeClient(opts: { failDownload?: string; failUpload?: boolean } = {}) {
  const downloads: string[] = [];
  const uploads: Array<{ contentType: string; filename?: string }> = [];
  return {
    downloads,
    uploads,
    downloadMedia: async (mxcUrl: string) => {
      downloads.push(mxcUrl);
      if (mxcUrl === opts.failDownload) throw new Error("HTTP 404");
      return { bytes: Buffer.from(mxcUrl), contentType: "image/png" };
    },
    uploadMedia: async (_bytes: Uint8Array, contentType: string, filename?: string) => {
      if (opts.failUpload) throw new Error("HTTP 500");
      uploads.push({ contentType, ...(filename ? { filename } : {}) });
      return `mxc://server/up${uploads.length}`;
    },
  };
}

const msg = (event_id: string, media: WorkMessage["media"]): WorkMessage => ({
  event_id,
  sender: "@ada:s",
  body: "",
  ts: 1,
  ...(media ? { media } : {}),
});

const savedTo = async (bytes: Buffer, contentType?: string, filename?: string) => ({
  path: `/media/${filename ?? bytes.toString()}`,
  ...(contentType ? { contentType } : {}),
});

test("fetchInboundMedia: saves each attachment under its message", async () => {
  const client = fakeClient();
  const logs: string[] = [];
  const media = await fetchInboundMedia(
    client,
    [
      msg("$a", [{ mxc_url: "mxc://s/1", filename: "cat.png" }]),
      msg("$b", undefined),
      msg("$c", [{ mxc_url: "mxc://s/2", filename: "doc.pdf", mimetype: "application/pdf" }]),
    ],
    { log: (m) => logs.push(m) },
    { save: savedTo },
  );
  assert.deepEqual(media, [
    { path: "/media/cat.png", contentType: "image/png", messageId: "$a" },
    { path: "/media/doc.pdf", contentType: "image/png", messageId: "$c" },
  ]);
  assert.deepEqual(logs, []);
});

test("fetchInboundMedia: skips what is too big or fails, and caps the count", async () => {
  const client = fakeClient({ failDownload: "mxc://s/broken" });
  const logs: string[] = [];
  const many = Array.from({ length: MAX_INBOUND_MEDIA + 2 }, (_, i) => ({
    mxc_url: `mxc://s/${i}`,
  }));
  const media = await fetchInboundMedia(
    client,
    [
      msg("$big", [{ mxc_url: "mxc://s/big", size: MEDIA_MAX_BYTES + 1 }]),
      msg("$broken", [{ mxc_url: "mxc://s/broken" }]),
      msg("$many", many),
    ],
    { log: (m) => logs.push(m) },
    { save: savedTo },
  );
  assert.ok(!client.downloads.includes("mxc://s/big"));
  assert.equal(client.downloads.length, MAX_INBOUND_MEDIA - 1);
  assert.equal(media.length, MAX_INBOUND_MEDIA - 2);
  assert.ok(logs.some((l) => l.includes("fetching the first")));
  assert.ok(logs.some((l) => l.includes("over the limit")));
  assert.ok(logs.some((l) => l.includes("could not fetch mxc://s/broken")));
});

test("uploadOutboundMedia: uploads each file and names it", async () => {
  const client = fakeClient();
  const attachments = await uploadOutboundMedia(
    client,
    ["/work/chart.png", "https://example.test/report"],
    { mediaLocalRoots: ["/work"], log: () => {} },
    {
      load: async (url) =>
        url.endsWith(".png")
          ? { buffer: Buffer.from("png"), contentType: "image/png", fileName: "chart.png" }
          : { buffer: Buffer.from("pdf") },
    },
  );
  assert.deepEqual(attachments, [
    { mxc_url: "mxc://server/up1", filename: "chart.png" },
    { mxc_url: "mxc://server/up2" },
  ]);
  assert.deepEqual(client.uploads, [
    { contentType: "image/png", filename: "chart.png" },
    { contentType: "application/octet-stream" },
  ]);
});

test("uploadOutboundMedia: a file that cannot be loaded or uploaded is dropped and logged", async () => {
  const logs: string[] = [];
  const refused = await uploadOutboundMedia(
    fakeClient(),
    ["/etc/passwd"],
    { mediaLocalRoots: ["/work"], log: (m) => logs.push(m) },
    {
      load: async () => {
        throw new Error("path is outside the allowed roots");
      },
    },
  );
  assert.deepEqual(refused, []);
  const failed = await uploadOutboundMedia(
    fakeClient({ failUpload: true }),
    ["/work/a.png"],
    { mediaLocalRoots: ["/work"], log: (m) => logs.push(m) },
    { load: async () => ({ buffer: Buffer.from("a") }) },
  );
  assert.deepEqual(failed, []);
  assert.equal(logs.length, 2);
});
