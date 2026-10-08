/**
 * The plugin's persistence: one table per namespace in OpenClaw's plugin-state store, which lives
 * in the gateway's SQLite and survives the hot reloads that every config write causes. This is the
 * only file that touches the OpenClaw API; a table file declares its record type and the verbs
 * its flow needs.
 */
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";

import { PLUGIN_ID } from "../accounts.js";

export interface Table<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  /** Read and delete in one step: for markers that must be acted on exactly once. */
  take(key: string): T | undefined;
  delete(key: string): void;
}

// Structural: the store's runtime module is only present inside the gateway.
interface Backend<T> {
  lookup(key: string): T | undefined;
  register(key: string, value: T): void;
  consume(key: string): T | undefined;
  delete(key: string): boolean;
}

type OpenBackend = <T>(namespace: string, maxEntries: number) => Backend<T>;

const openclawBackend: OpenBackend = <T>(namespace: string, maxEntries: number) =>
  createPluginStateSyncKeyedStore<T>(PLUGIN_ID, {
    namespace,
    maxEntries,
    overflowPolicy: "evict-oldest",
  }) as unknown as Backend<T>;

const memoryBackend: OpenBackend = <T>(): Backend<T> => {
  const rows = new Map<string, T>();
  return {
    lookup: (key) => rows.get(key),
    register: (key, value) => void rows.set(key, value),
    consume: (key) => {
      const value = rows.get(key);
      rows.delete(key);
      return value;
    },
    delete: (key) => rows.delete(key),
  };
};

let openBackend: OpenBackend = openclawBackend;

/** Tests run outside the gateway: tables opened after this call keep their rows in memory. */
export function useMemoryState(): void {
  openBackend = memoryBackend;
}

// Reopening a namespace with different options throws on a hot reload: a table's options never
// change; new options need a new namespace. The backend opens on first use, not at import.
export function openTable<T>(namespace: string, maxEntries = 32): Table<T> {
  let backend: Backend<T> | undefined;
  const open = () => (backend ??= openBackend<T>(namespace, maxEntries));
  return {
    get: (key) => open().lookup(key),
    set: (key, value) => open().register(key, value),
    take: (key) => open().consume(key),
    delete: (key) => void open().delete(key),
  };
}
