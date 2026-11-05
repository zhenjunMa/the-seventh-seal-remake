// Cache source definitions and prepared indexes, never scene/playback state.
// Loader and registration identities isolate custom tools and changed inputs.
export class BattleDefinitionCache {
  constructor() { this.loaders = new WeakMap(); }

  async load(loader, content, identity, prepare) {
    let contents = this.loaders.get(loader);
    if (!contents) { contents = new WeakMap(); this.loaders.set(loader, contents); }
    let entries = contents.get(content);
    if (!entries) { entries = new Map(); contents.set(content, entries); }
    if (!entries.has(identity)) {
      const pending = Promise.resolve().then(prepare).catch(error => {
        if (entries.get(identity) === pending) entries.delete(identity);
        throw error;
      });
      entries.set(identity, pending);
    }
    return entries.get(identity);
  }
}

export const battleDefinitions = new BattleDefinitionCache();
