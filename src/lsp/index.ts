// Type definitions
export type {
	LSPServerStatus,
	LSPEnrichmentData,
	EnrichedCodeBlock,
	ILSPClient,
	ILSPEnricher,
	LSPEnricherOptions,
} from "./types.js"

export {
	DEFAULT_LSP_OPTIONS,
	EXTENSION_TO_LANGUAGE,
	LANGUAGE_TO_EXTENSIONS,
} from "./types.js"

// Core classes
export { LSPServerManager } from "./lsp-server-manager.js"
export type { LSPServerManagerConfig } from "./lsp-server-manager.js"

export { LSPEnricher } from "./lsp-enricher.js"
export { LSPCache } from "./lsp-cache.js"

// Language-specific clients
export { TypeScriptLSPClient } from "./typescript-client.js"
export { CSharpLSPClient } from "./csharp-client.js"
