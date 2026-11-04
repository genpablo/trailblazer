/** Per-visitor storage. Can be unavailable (private mode, blocked third-party storage in iframes). */

const memory = new Map<string, string>();

function get(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function set(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
}

export function visitorId(publicKey: string): string {
  const key = `tb:${publicKey}:visitor`;
  let id = get(key);
  if (!id) {
    id = crypto.randomUUID();
    set(key, id);
  }
  return id;
}

export const conversationStore = {
  get: (publicKey: string) => get(`tb:${publicKey}:conversation`),
  set: (publicKey: string, id: string | null) => set(`tb:${publicKey}:conversation`, id),
};

export const languageStore = {
  get: (publicKey: string) => get(`tb:${publicKey}:lang`),
  set: (publicKey: string, lang: string) => set(`tb:${publicKey}:lang`, lang),
};
