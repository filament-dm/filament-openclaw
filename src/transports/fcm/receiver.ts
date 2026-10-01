/**
 * One account's FCM receiver. Each account registers separately: the server keeps one push token
 * per agent.
 *
 * `@eneris/push-receiver` speaks Google's MCS protocol, so a headless process can receive FCM data
 * messages: `firebase-admin` only sends, and the `firebase` web SDK needs a browser. Fresh
 * registrations hit Google's flaky PHONE_REGISTRATION_ERROR, hence the connect retries.
 */
import { PushReceiver } from "@eneris/push-receiver";

import type { FirebaseSettings } from "../../settings.js";
import {
  type FcmCredentials,
  hasFcmCredentialsForOtherProject,
  loadFcmCredentials,
  loadReceivedIds,
  recordReceivedId,
  saveFcmCredentials,
} from "../../token-store.js";
import { sleepAbortable } from "../../util.js";

/** Structural subset of eneris `MessageEnvelope`; `persistentId` is the dedup key. */
export interface FcmMessageEnvelope {
  message?: { data?: Record<string, unknown> };
  persistentId: string;
}

const DEFAULT_CONNECT_ATTEMPTS = 12;
const RETRY_BASE_MS = 1_500;
const RETRY_CAP_MS = 5_000;

function connectAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FILAMENT_FCM_REGISTER_ATTEMPTS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return DEFAULT_CONNECT_ATTEMPTS;
}

export interface FcmReceiverOptions {
  accountId: string;
  firebase: FirebaseSettings;
  log: (message: string) => void;
  /** Called after cross-restart dedup by persistent id. */
  onMessage: (env: FcmMessageEnvelope) => void;
  abortSignal?: AbortSignal;
}

export class FcmReceiver {
  private receiver: PushReceiver | null = null;

  constructor(private readonly opts: FcmReceiverOptions) {}

  token(): string | null {
    const { accountId, firebase } = this.opts;
    const live = this.receiver?.fcmToken;
    if (live) return live;
    return loadFcmCredentials(accountId, firebase.projectId)?.fcm?.token ?? null;
  }

  async start(): Promise<void> {
    const { accountId, firebase, log, onMessage, abortSignal } = this.opts;
    const saved = loadFcmCredentials(accountId, firebase.projectId);
    if (!saved && hasFcmCredentialsForOtherProject(accountId, firebase.projectId)) {
      log(
        `filament-fcm: saved credentials are for another Firebase project; re-registering against ${firebase.projectId}`,
      );
    }
    const receiver = new PushReceiver({
      firebase: {
        projectId: firebase.projectId,
        apiKey: firebase.apiKey,
        appId: firebase.appId,
        messagingSenderId: firebase.messagingSenderId,
      },
      credentials: (saved ?? null) as never,
      // Seed already-processed ids so Google doesn't redeliver them on reconnect.
      persistentIds: loadReceivedIds(accountId),
    });
    receiver.onCredentialsChanged(({ newCredentials }) => {
      saveFcmCredentials(
        accountId,
        newCredentials as unknown as FcmCredentials,
        firebase.projectId,
      );
    });
    // Every raw arrival is logged first, so "no push arrived" can be told
    // apart from "arrived but deduped/undecodable".
    receiver.onNotification((envelope) => {
      const env = envelope as unknown as FcmMessageEnvelope;
      const pid = env.persistentId;
      const keys = env.message?.data ? Object.keys(env.message.data) : [];
      log(`filament-fcm: push received pid=${pid || "(none)"} data-keys=[${keys.join(",")}]`);
      // Dedup only with a persistent id; a missing one must not drop the push.
      if (pid && !recordReceivedId(accountId, pid)) {
        log(`filament-fcm: duplicate push pid=${pid}; skipping`);
        return;
      }
      try {
        onMessage(env);
      } catch (error) {
        log(`filament-fcm: inbound handler threw (continuing): ${String(error)}`);
      }
    });
    this.receiver = receiver;

    const attempts = connectAttempts();
    let lastError: unknown;
    for (let i = 1; i <= attempts; i++) {
      if (abortSignal?.aborted) throw new Error("aborted");
      try {
        await receiver.connect();
        log(
          `filament-fcm: receiver connected (attempt ${i}/${attempts}, project ${firebase.projectId})`,
        );
        return;
      } catch (error) {
        lastError = error;
        log(`filament-fcm: connect attempt ${i}/${attempts} failed: ${String(error)}`);
        if (i < attempts) {
          await sleepAbortable(Math.min(RETRY_BASE_MS * i, RETRY_CAP_MS), abortSignal);
        }
      }
    }
    throw new Error(`FCM connect failed after ${attempts} attempts: ${String(lastError)}`);
  }

  stop(): void {
    this.receiver?.destroy?.();
    this.receiver = null;
  }
}
