/**
 * Filament FCM configuration and receiver factory.
 *
 * This mirrors the Firebase project configuration and environment-variable
 * overrides used by the Python `filament-hermes` plugin (see
 * `hermes_filament_fcm/fcm_client.py`), but built on `@eneris/push-receiver` —
 * the Node/TypeScript sibling of the Python `firebase-messaging` library.
 *
 * Both libraries speak Google's MCS (Mobile Connection Server) protocol
 * directly so a *headless* process can RECEIVE FCM data messages. That is the
 * whole trick, and it is why we do not use an official Firebase package here:
 *   - `firebase-admin` (server SDK) only SENDS messages; it cannot receive.
 *   - the `firebase` web SDK can receive, but only inside a browser (it needs
 *     a Service Worker + the Web Push API), so it will not run in the gateway.
 * `@eneris/push-receiver` is the same approach Filament's own Electron desktop
 * client uses (`fcm-push-receiver.ts`), so it stays wire-compatible with the
 * DirectPusher payloads the Filament server sends.
 *
 * Field mapping (Python FcmRegisterConfig -> @eneris FirebaseConfig):
 *   project_id -> projectId
 *   app_id     -> appId
 *   api_key    -> apiKey
 *   sender_id  -> messagingSenderId
 */
import { PushReceiver } from "@eneris/push-receiver";

import {
  cachedToken,
  loadCredentials,
  loadReceivedIds,
  recordReceivedId,
  saveCredentials,
  type FcmCredentials,
} from "./token-store.js";
import type { TokenSnapshot } from "./conformance-core.js";

/**
 * The bits of an eneris `MessageEnvelope` we consume. Kept structural so this
 * module doesn't depend on the library's exported type names; `message.data` is
 * the FCM data dict (the DirectPusher payload), `persistentId` the dedup key.
 */
export interface FcmMessageEnvelope {
  message?: { data?: Record<string, unknown> };
  persistentId: string;
}

// Filament Firebase project defaults — shared across all environments. These
// are public configuration values (identical to what ships in the Filament
// Electron app's fcm-push-receiver.ts and the mobile google-services.json).
// We use the web app id, matching the Electron desktop client, because the
// gateway is a non-mobile FCM client. Override via env vars if needed.
const DEFAULT_FIREBASE_PROJECT_ID = "filament-8ce44";
const DEFAULT_FIREBASE_API_KEY = "AIzaSyBtYzzP3IRpmIZ57dp1PMS4Y8RPjTB0snk";
const DEFAULT_FIREBASE_APP_ID = "1:143821144946:web:90e517a7f36aa42a6093eb";
const DEFAULT_FIREBASE_SENDER_ID = "143821144946";

export interface FilamentFcmConfig {
  projectId: string;
  apiKey: string;
  appId: string;
  messagingSenderId: string;
}

/** Resolve the FCM registration config from the environment, with defaults. */
export function resolveFcmConfig(env: NodeJS.ProcessEnv = process.env): FilamentFcmConfig {
  return {
    projectId: env.FILAMENT_FIREBASE_PROJECT_ID || DEFAULT_FIREBASE_PROJECT_ID,
    apiKey: env.FILAMENT_FIREBASE_API_KEY || DEFAULT_FIREBASE_API_KEY,
    appId: env.FILAMENT_FIREBASE_APP_ID || DEFAULT_FIREBASE_APP_ID,
    messagingSenderId: env.FILAMENT_FIREBASE_SENDER_ID || DEFAULT_FIREBASE_SENDER_ID,
  };
}

/**
 * Construct the FCM push receiver. This does NOT connect — it only builds the
 * client, which is enough to prove the dependency is wired and the Firebase
 * config is well-formed. Connecting (a persistent MCS socket), credential
 * persistence, and payload parsing arrive in a later iteration, mirroring
 * `FilamentFCMClient` in the Python plugin.
 */
export function createReceiver(config: FilamentFcmConfig = resolveFcmConfig()): PushReceiver {
  return new PushReceiver({
    firebase: {
      projectId: config.projectId,
      apiKey: config.apiKey,
      appId: config.appId,
      messagingSenderId: config.messagingSenderId,
    },
    // Fresh registration on first run; persisted credentials come later (the
    // Python plugin saves these across restarts so pushes are not redelivered).
    persistentIds: [],
  });
}

// ── Live FCM registration ────────────────────────────────────────────
//
// Mirrors Hermes' FilamentFCMClient.checkin_or_register: load saved
// credentials, register/connect via @eneris/push-receiver, and persist the
// credentials so restarts reuse the registration. Fresh registrations hit
// Google's flaky PHONE_REGISTRATION_ERROR, so connect is retried with a gentle
// backoff (same rationale as the Python plugin). Message parsing/dispatch is a
// later iteration; for now we just register, hold the socket, and cache the
// token.

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Build a TokenSnapshot from the cached credentials, or null when none exist.
 * `connected` reflects whether a live receiver currently holds the socket.
 */
export function buildSnapshot(
  connected: boolean,
  config: FilamentFcmConfig = resolveFcmConfig(),
): TokenSnapshot | null {
  const token = cachedToken();
  if (!token) return null;
  return {
    token,
    projectId: config.projectId,
    senderId: config.messagingSenderId,
    connected,
    source: connected ? "live" : "cache",
  };
}

/** A live FCM registration + receiver connection with credential persistence. */
export class FcmConnection {
  private receiver: PushReceiver | null = null;
  private connected = false;

  constructor(
    private readonly config: FilamentFcmConfig = resolveFcmConfig(),
    private readonly log: (message: string) => void = () => {},
    /**
     * Called for each new inbound push (after cross-restart dedup). The raw
     * envelope is decoded/dispatched by the caller; FcmConnection only owns the
     * socket + credential/persistent-id persistence.
     */
    private readonly onMessage?: (env: FcmMessageEnvelope) => void,
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  snapshot(): TokenSnapshot | null {
    return buildSnapshot(this.connected, this.config);
  }

  /** Register (reusing saved credentials if any) and connect, with retry. */
  async start(): Promise<void> {
    const saved = loadCredentials();
    const receiver = new PushReceiver({
      firebase: {
        projectId: this.config.projectId,
        apiKey: this.config.apiKey,
        appId: this.config.appId,
        messagingSenderId: this.config.messagingSenderId,
      },
      // eneris Credentials is a superset; we persist/reload it opaquely.
      credentials: (saved ?? null) as never,
      // Seed already-processed IDs so Google doesn't redeliver them on reconnect.
      persistentIds: loadReceivedIds(),
    });
    // Persist credentials whenever eneris (re)generates them, so a restart
    // reuses the registration and the cached token stays current.
    receiver.onCredentialsChanged(({ newCredentials }) => {
      saveCredentials(newCredentials as FcmCredentials);
    });
    // Deliver inbound pushes to the caller, deduped durably by persistent ID so
    // a redelivery (or a restart mid-dispatch) doesn't double-process. Every
    // raw arrival is logged first so we can tell "no push arrived" apart from
    // "arrived but deduped/undecodable".
    receiver.onNotification((envelope) => {
      const env = envelope as unknown as FcmMessageEnvelope;
      const pid = env.persistentId;
      const keys = env.message?.data ? Object.keys(env.message.data) : [];
      this.log(`filament-fcm: push received pid=${pid || "(none)"} data-keys=[${keys.join(",")}]`);
      // Dedup only when we actually have a persistent ID; a missing ID must not
      // silently drop the push.
      if (pid && !recordReceivedId(pid)) {
        this.log(`filament-fcm: duplicate push pid=${pid}; skipping`);
        return;
      }
      try {
        this.onMessage?.(env);
      } catch (error) {
        this.log(`filament-fcm: inbound handler threw (continuing): ${String(error)}`);
      }
    });
    this.receiver = receiver;

    const attempts = connectAttempts();
    let lastError: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        await receiver.connect();
        this.connected = true;
        this.log(
          `filament-fcm: FCM receiver connected (attempt ${i}/${attempts}); token ${cachedToken() ? "cached" : "missing"}`,
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
  stop(): void {
    this.connected = false;
    this.receiver?.destroy?.();
    this.receiver = null;
  }
}
