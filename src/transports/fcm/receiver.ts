/**
 * The live FCM push receiver for one channel account.
 *
 * Restored from the original FCM plugin (Jonathan Strickland, `main`'s
 * src/fcm.ts), made per account: each account registers on its own and keeps
 * its own credentials and processed-id window, because Filament keeps one push
 * token per agent (ENG-1588) and each account is a different agent.
 *
 * Built on `@eneris/push-receiver`, which speaks Google's MCS protocol so a
 * *headless* process can RECEIVE FCM data messages — the same approach the
 * Electron desktop client (`fcm-push-receiver.ts`) and the Python
 * `filament-hermes` plugin (`firebase-messaging`) use. `firebase-admin` only
 * sends, and the `firebase` web SDK needs a browser.
 *
 * Fresh registrations hit Google's flaky PHONE_REGISTRATION_ERROR, so connect
 * is retried with a gentle backoff (the same rationale as the Python plugin).
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

/**
 * The bits of an eneris `MessageEnvelope` we consume. Kept structural so this
 * module doesn't depend on the library's exported type names; `message.data` is
 * the FCM data dict (the DirectPusher payload), `persistentId` the dedup key.
 */
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
  /** Each new push, after cross-restart dedup by persistent id. */
  onMessage: (env: FcmMessageEnvelope) => void;
  abortSignal?: AbortSignal;
}

/** A live FCM registration + receiver connection with credential persistence. */
export class FcmReceiver {
  private receiver: PushReceiver | null = null;

  constructor(private readonly opts: FcmReceiverOptions) {}

  /** The account's current FCM registration token, once registered. */
  token(): string | null {
    const { accountId, firebase } = this.opts;
    const live = this.receiver?.fcmToken;
    if (live) return live;
    return loadFcmCredentials(accountId, firebase.projectId)?.fcm?.token ?? null;
  }

  /** Register (reusing saved credentials if any) and connect, with retry. */
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
      // eneris Credentials is a superset; we persist/reload it opaquely.
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

  /** Tear down the receiver socket. */
  stop(): void {
    this.receiver?.destroy?.();
    this.receiver = null;
  }
}
