/**
 * Backwards-compatible facade: artifacts now live in Workers KV (no R2).
 * Kept so existing imports keep working while the storage backend changed.
 */
export * from './store.js';
