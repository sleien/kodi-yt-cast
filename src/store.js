// The receiver's DataStore as one JSON file, so the TV keeps its identity
// (app.pid, mdxContext) across restarts and phones reconnect without
// pairing again.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DataStore } from 'yt-cast-receiver';

export class FileDataStore extends DataStore {
  #path;
  #data = null;

  constructor(path) {
    super();
    this.#path = path;
  }

  async #load() {
    if (this.#data === null) {
      try {
        this.#data = JSON.parse(await readFile(this.#path, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        this.#data = {};
      }
    }
    return this.#data;
  }

  async get(key) {
    const data = await this.#load();
    return key in data ? data[key] : null;
  }

  async set(key, value) {
    const data = await this.#load();
    data[key] = value;
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, this.#path);
  }
}
