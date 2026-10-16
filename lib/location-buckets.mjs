// Stable, build/runtime-shared assignment of a city slug to a small metadata shard.
export function cityBucket(slug, count) {
  if (!/^[a-z0-9-]+$/.test(slug) || !Number.isSafeInteger(count) || count < 1) {
    throw new TypeError('Invalid city bucket identity');
  }
  let hash = 2166136261;
  for (let i = 0; i < slug.length; i++) hash = Math.imul(hash ^ slug.charCodeAt(i), 16777619);
  return (hash >>> 0) % count;
}
