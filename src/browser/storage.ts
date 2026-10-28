// Storage port: IndexedDB, falling back to localStorage, falling back to memory. The device id is
// also mirrored in localStorage (protocol 11.1), so it survives either store being cleared alone.

import type { Loaded, PersistedState, QueuedEvent, Storage } from "../core/ports";

const STATE_KEY = "state";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function local(): globalThis.Storage | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    return undefined; // access throws when site data is blocked
  }
}

function mirror(ns: string): { get(): string | undefined; set(id: string): void } {
  const key = `ipase:${ns}:device`;
  return {
    get() {
      try {
        return local()?.getItem(key) || undefined;
      } catch {
        return undefined;
      }
    },
    set(id) {
      try {
        local()?.setItem(key, id);
      } catch {
        // best effort
      }
    },
  };
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("kv");
      r.result.createObjectStore("queue", { keyPath: "k" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

function indexedDbStorage(db: IDBDatabase, ns: string): Storage {
  const device = mirror(ns);
  const write = (stores: string[], fn: (tx: IDBTransaction) => void): Promise<void> => {
    const tx = db.transaction(stores, "readwrite");
    fn(tx);
    return done(tx);
  };
  return {
    async load(): Promise<Loaded> {
      const tx = db.transaction(["kv", "queue"], "readonly");
      const [state, queue] = await Promise.all([
        req(tx.objectStore("kv").get(STATE_KEY)) as Promise<PersistedState | undefined>,
        req(tx.objectStore("queue").getAll()) as Promise<QueuedEvent[]>,
      ]);
      return { state, queue, deviceId: device.get() };
    },
    saveState: (state) => {
      device.set(state.deviceId);
      return write(["kv"], (tx) => tx.objectStore("kv").put(state, STATE_KEY));
    },
    append: (items) => write(["queue"], (tx) => items.forEach((i) => tx.objectStore("queue").put(i))),
    remove: (keys) => write(["queue"], (tx) => keys.forEach((k) => tx.objectStore("queue").delete(k))),
    clearQueue: () => write(["queue"], (tx) => tx.objectStore("queue").clear()),
    close: () => db.close(),
  };
}

/** Whole-value storage in localStorage, or in memory when there is no localStorage at all. */
function keyValueStorage(ns: string): Storage {
  const ls = local();
  const memory: { [key: string]: string } = {};
  const get = (key: string): string | null => (ls ? ls.getItem(`ipase:${ns}:${key}`) : memory[key] ?? null);
  const set = (key: string, value: string): void => {
    if (ls) ls.setItem(`ipase:${ns}:${key}`, value);
    else memory[key] = value;
  };
  const device = mirror(ns);
  let queue: QueuedEvent[] = [];
  const saveQueue = async () => set("queue", JSON.stringify(queue));
  return {
    async load() {
      const state = get(STATE_KEY);
      queue = JSON.parse(get("queue") || "[]");
      return { state: state ? JSON.parse(state) : undefined, queue: queue.slice(), deviceId: device.get() };
    },
    async saveState(state) {
      set(STATE_KEY, JSON.stringify(state));
      device.set(state.deviceId);
    },
    append(items) {
      queue = queue.concat(items);
      return saveQueue();
    },
    remove(keys) {
      queue = queue.filter((q) => keys.indexOf(q.k) < 0);
      return saveQueue();
    },
    clearQueue() {
      queue = [];
      return saveQueue();
    },
  };
}

/** Storage namespaced by write key, so two projects on one origin keep separate queues. */
export function browserStorage(ns: string): Storage {
  const impl: Promise<Storage> = openDb(`ipase:${ns}`).then(
    (db) => indexedDbStorage(db, ns),
    () => keyValueStorage(ns),
  );
  return {
    load: () => impl.then((s) => s.load()),
    saveState: (state) => impl.then((s) => s.saveState(state)),
    append: (items) => impl.then((s) => s.append(items)),
    remove: (keys) => impl.then((s) => s.remove(keys)),
    clearQueue: () => impl.then((s) => s.clearQueue()),
    close: () => {
      impl.then((s) => s.close && s.close());
    },
  };
}
