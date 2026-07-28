import { PushReceiver } from "@eneris/push-receiver";
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
export {
  createReceiver,
  resolveFcmConfig
};
//# sourceMappingURL=fcm.js.map
