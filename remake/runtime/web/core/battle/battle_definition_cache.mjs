// Cache source definitions and prepared indexes, never scene/playback state.
// Loader and registration identities isolate custom tools and changed inputs.
export class BattleDefinitionCache {
  constructor() { this.loaders = new WeakMap(); }

  async load(loader, content, identity, prepare, {limit=Infinity}={}) {
    let contents = this.loaders.get(loader);
    if (!contents) { contents = new WeakMap(); this.loaders.set(loader, contents); }
    let entries = contents.get(content);
    if (!entries) { entries = new Map(); contents.set(content, entries); }
    let entry = entries.get(identity);
    if (entry) entries.delete(identity);
    else {
      entry = {bounded:Number.isFinite(limit), pending:null};
      entry.pending = Promise.resolve().then(prepare).catch(error => {
        if (entries.get(identity) === entry) entries.delete(identity);
        throw error;
      });
    }
    entries.set(identity, entry);
    if(entry.bounded){
      const bounded=[...entries].filter(([,candidate])=>candidate.bounded);
      for(const [key] of bounded.slice(0,Math.max(0,bounded.length-limit)))entries.delete(key);
    }
    return entry.pending;
  }
}

export const battleDefinitions = new BattleDefinitionCache();
