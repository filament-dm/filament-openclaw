import { PushReceiver } from "@eneris/push-receiver";
import {
  cachedToken,
  loadCredentials,
  saveCredentials
} from "./token-store.js";
const DEFAULT_FIREBASE_PROJECT_ID = "filament-8ce44";
const DEFAULT_FIREBASE_API_KEY = "AIzaSyBtYzzP3IRpmIZ57dp1PMS4Y8RPjTB0snk";
const DEFAULT_FIREBASE_APP_ID = "1:143821144946:web:90e517a7f36aa42a6093eb";
const DEFAULT_FIREBASE_SENDER_ID = "143821144946";
function resolveFcmConfig(env = process.env) {
  return {
    projectId: env.FILAMENT_FIREBASE_PROJECT_ID || DEFAULT_FIREBASE_PROJECT_ID,
    apiKey: env.FILAMENT_FIREBASE_API_KEY || DEFAULT_FIREBASE_API_KEY,
    appId: env.FILAMENT_FIREBASE_APP_ID || DEFAULT_FIREBASE_APP_ID,
    messagingSenderId: env.FILAMENT_FIREBASE_SENDER_ID || DEFAULT_FIREBASE_SENDER_ID
  };
}
function createReceiver(config = resolveFcmConfig()) {
  return new PushReceiver({
    firebase: {
      projectId: config.projectId,
      apiKey: config.apiKey,
      appId: config.appId,
      messagingSenderId: config.messagingSenderId
    },
    // Fresh registration on first run; persisted credentials come later (the
    // Python plugin saves these across restarts so pushes are not redelivered).
    persistentIds: []
  });
}
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function buildSnapshot(connected, config = resolveFcmConfig()) {
  const token = cachedToken();
  if (!token) return null;
  return {
    token,
    projectId: config.projectId,
    senderId: config.messagingSenderId,
    connected,
    source: connected ? "live" : "cache"
  };
}
class FcmConnection {
  constructor(config = resolveFcmConfig(), log = () => {
  }) {
    this.config = config;
    this.log = log;
  }
  receiver = null;
  connected = false;
  isConnected() {
    return this.connected;
  }
  snapshot() {
    return buildSnapshot(this.connected, this.config);
  }
  /** Register (reusing saved credentials if any) and connect, with retry. */
  async start() {
    const saved = loadCredentials();
    const receiver = new PushReceiver({
      firebase: {
        projectId: this.config.projectId,
        apiKey: this.config.apiKey,
        appId: this.config.appId,
        messagingSenderId: this.config.messagingSenderId
      },
      // eneris Credentials is a superset; we persist/reload it opaquely.
      credentials: saved ?? null,
      persistentIds: []
    });
    receiver.onCredentialsChanged(({ newCredentials }) => {
      saveCredentials(newCredentials);
    });
    this.receiver = receiver;
    const attempts = connectAttempts();
    let lastError;
    for (let i = 1; i <= attempts; i++) {
      try {
        await receiver.connect();
        this.connected = true;
        this.log(
          `filament-fcm: FCM receiver connected (attempt ${i}/${attempts}); token ${cachedToken() ? "cached" : "missing"}`
        );
        return;
      } catch (error) {
        lastError = error;
        this.log(`filament-fcm: connect attempt ${i}/${attempts} failed: ${String(error)}`);
        if (i < attempts) await sleep(Math.min(RETRY_BASE_MS * i, RETRY_CAP_MS));
      }
    }
    throw new Error(`FCM connect failed after ${attempts} attempts: ${String(lastError)}`);
  }
  /** Tear down the receiver socket. */
  stop() {
    this.connected = false;
    this.receiver?.destroy?.();
    this.receiver = null;
  }
}
export {
  FcmConnection,
  buildSnapshot,
  createReceiver,
  resolveFcmConfig
};
//# sourceMappingURL=fcm.js.map
