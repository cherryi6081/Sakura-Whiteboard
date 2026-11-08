export type StorageProbe = {
  localStorage: Record<string, string>;
  indexedDB: string[];
  cookie: string;
};

export async function probeStorage(): Promise<StorageProbe> {
  const ls: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key === null) continue;
    ls[key] = (localStorage.getItem(key) ?? "").slice(0, 400);
  }

  let dbNames: string[] = [];
  try {
    const dbs = await indexedDB.databases();
    dbNames = dbs.map((d) => `${d.name ?? "(unnamed)"}@${d.version ?? "?"}`);
  } catch (err) {
    dbNames = [`ERROR: ${String(err)}`];
  }

  return { localStorage: ls, indexedDB: dbNames, cookie: document.cookie };
}
