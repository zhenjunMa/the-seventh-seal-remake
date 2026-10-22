// Scope-owned decoded images. A failed load can be retried; releasing an
// unused scene also releases the cache's references to its decoded pixels.
export class ImageResources {
  constructor({createImage = () => new Image()} = {}) {
    this.createImage = createImage;
    this.entries = new Map();
    this.revision = 0;
  }
  load(path, scope = 'shared') {
    let entry = this.entries.get(path);
    if (entry) {
      if (!entry.scopes.has(scope)) { entry.scopes.add(scope); this.revision++; }
      return entry.promise;
    }
    entry = {scopes:new Set([scope]), bitmap:null, promise:null};
    this.entries.set(path, entry);
    this.revision++;
    entry.promise = new Promise((resolve, reject) => {
      const bitmap = this.createImage();
      bitmap.onload = () => { bitmap.onload = bitmap.onerror = null; entry.bitmap = bitmap; resolve(bitmap); };
      bitmap.onerror = () => {
        bitmap.onload = bitmap.onerror = null;
        if (this.entries.get(path) === entry) { this.entries.delete(path); this.revision++; }
        reject(new Error(`图像加载失败：${path}`));
      };
      bitmap.src = path;
    });
    return entry.promise;
  }
  peek(path) { return this.entries.get(path)?.bitmap ?? null; }
  async attach(target, path, scope, property = 'bitmap') {
    const bitmap = await this.load(path, scope);
    const entry = this.entries.get(path);
    if (entry?.bitmap === bitmap && entry.scopes.has(scope)) target[property] = bitmap;
    return bitmap;
  }
  async loadMany(paths, scope) { return Promise.all([...new Set(paths)].map(path => this.load(path, scope))); }
  retainScopes(scopes) {
    const keep = new Set(scopes);
    let released = 0;
    for (const [path, entry] of this.entries) {
      for (const scope of entry.scopes) if (!keep.has(scope)) { entry.scopes.delete(scope); this.revision++; }
      if (!entry.scopes.size) { this.entries.delete(path); released++; this.revision++; }
    }
    return released;
  }
  snapshot() {
    let ready = 0, decodedBytes = 0;
    const scopes = new Set();
    for (const entry of this.entries.values()) {
      for (const scope of entry.scopes) scopes.add(scope);
      if (entry.bitmap) { ready++; decodedBytes += entry.bitmap.width * entry.bitmap.height * 4; }
    }
    return {entries:this.entries.size, ready, pending:this.entries.size - ready,
      estimatedDecodedBytes:decodedBytes, scopes:[...scopes].sort()};
  }
}
