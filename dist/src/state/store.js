import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";
import { PLUGIN_ID } from "../accounts.js";
const openclawBackend = (namespace, maxEntries) => createPluginStateSyncKeyedStore(PLUGIN_ID, {
  namespace,
  maxEntries,
  overflowPolicy: "evict-oldest"
});
const memoryBackend = () => {
  const rows = /* @__PURE__ */ new Map();
  return {
    lookup: (key) => rows.get(key),
    register: (key, value) => void rows.set(key, value),
    consume: (key) => {
      const value = rows.get(key);
      rows.delete(key);
      return value;
    },
    delete: (key) => rows.delete(key)
  };
};
let openBackend = openclawBackend;
function useMemoryState() {
  openBackend = memoryBackend;
}
function openTable(namespace, maxEntries = 32) {
  let backend;
  const open = () => backend ??= openBackend(namespace, maxEntries);
  return {
    get: (key) => open().lookup(key),
    set: (key, value) => open().register(key, value),
    take: (key) => open().consume(key),
    delete: (key) => void open().delete(key)
  };
}
export {
  openTable,
  useMemoryState
};
