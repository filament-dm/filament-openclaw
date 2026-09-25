import { PushReceiver } from "@eneris/push-receiver";
import {
  hasFcmCredentialsForOtherProject,
  loadFcmCredentials,
  loadReceivedIds,
  recordReceivedId,
  saveFcmCredentials
} from "../../token-store.js";
import { sleepAbortable } from "../../util.js";
const DEFAULT_CONNECT_ATTEMPTS = 12;
const RETRY_BASE_MS = 1500;
const RETRY_CAP_MS = 5e3;
function connectAttempts(env = process.env) {
  const raw = env.FILAMENT_FCM_REGISTER_ATTEMPTS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return DEFAULT_CONNECT_ATTEMPTS;
}
class FcmReceiver {
  constructor(opts) {
    this.opts = opts;
  }
  receiver = null;
  /** The account's current FCM registration token, once registered. */
  token() {
    const { accountId, firebase } = this.opts;
    const live = this.receiver?.fcmToken;
    if (live) return live;
    return loadFcmCredentials(accountId, firebase.projectId)?.fcm?.token ?? null;
  }
  /** Register (reusing saved credentials if any) and connect, with retry. */
  async start() {
    const { accountId, firebase, log, onMessage, abortSignal } = this.opts;
    const saved = loadFcmCredentials(accountId, firebase.projectId);
    if (!saved && hasFcmCredentialsForOtherProject(accountId, firebase.projectId)) {
      log(
        `filament-fcm: saved credentials are for another Firebase project; re-registering against ${firebase.projectId}`
      );
    }
    const receiver = new PushReceiver({
      firebase: {
        projectId: firebase.projectId,
        apiKey: firebase.apiKey,
        appId: firebase.appId,
        messagingSenderId: firebase.messagingSenderId
      },
      // eneris Credentials is a superset; we persist/reload it opaquely.
      credentials: saved ?? null,
      // Seed already-processed ids so Google doesn't redeliver them on reconnect.
      persistentIds: loadReceivedIds(accountId)
    });
    receiver.onCredentialsChanged(({ newCredentials }) => {
      saveFcmCredentials(
        accountId,
        newCredentials,
        firebase.projectId
      );
    });
    receiver.onNotification((envelope) => {
      const env = envelope;
      const pid = env.persistentId;
      const keys = env.message?.data ? Object.keys(env.message.data) : [];
      log(`filament-fcm: push received pid=${pid || "(none)"} data-keys=[${keys.join(",")}]`);
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
    let lastError;
    for (let i = 1; i <= attempts; i++) {
      if (abortSignal?.aborted) throw new Error("aborted");
      try {
        await receiver.connect();
        log(
          `filament-fcm: receiver connected (attempt ${i}/${attempts}, project ${firebase.projectId})`
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
  stop() {
    this.receiver?.destroy?.();
    this.receiver = null;
  }
}
export {
  FcmReceiver
};
//# sourceMappingURL=receiver.js.map
