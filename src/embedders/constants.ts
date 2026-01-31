/**
 * Constants for embedder operations
 */

// Batch processing
export const MAX_BATCH_TOKENS = 100000
export const MAX_ITEM_TOKENS = 8191
export const MAX_BATCH_RETRIES = 3
export const INITIAL_RETRY_DELAY_MS = 500

// Gemini specific
export const GEMINI_MAX_ITEM_TOKENS = 2048

// Timeout constants
export const OLLAMA_EMBEDDING_TIMEOUT_MS = 60000
export const OLLAMA_VALIDATION_TIMEOUT_MS = 30000
