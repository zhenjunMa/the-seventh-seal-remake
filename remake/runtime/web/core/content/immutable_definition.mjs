// Only definitions frozen through this boundary may cross sessions by reference.
// Mutable caller inputs still receive the same defensive copy as before.
const definitions = new WeakSet();

export function freezeDefinition(value) {
  if (!value || typeof value !== 'object' || definitions.has(value)) return value;
  for (const child of Object.values(value)) freezeDefinition(child);
  Object.freeze(value);
  definitions.add(value);
  return value;
}

export function retainDefinition(value) {
  return value && typeof value === 'object' && definitions.has(value)
    ? value : structuredClone(value);
}

export function freezeDefinitionMap(entries) {
  const index = new Map(entries);
  for (const value of index.values()) freezeDefinition(value);
  const reject = () => { throw new TypeError('共享定义索引只读'); };
  Object.defineProperties(index, {
    set: {value:reject}, delete: {value:reject}, clear: {value:reject},
  });
  Object.freeze(index);
  definitions.add(index);
  return index;
}
