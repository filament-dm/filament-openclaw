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
