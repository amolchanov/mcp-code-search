import type { CodeBlock } from "../types/index.js"

/**
 * LSP server status
 */
export type LSPServerStatus = "stopped" | "starting" | "ready" | "error"

/**
 * Enrichment data extracted from LSP servers
 */
export interface LSPEnrichmentData {
	/** Type signature, e.g., "function add(a: number, b: number): number" */
	typeSignature?: string
	/** Documentation from JSDoc/XML doc comments */
	documentation?: string
	/** Symbol kind: "function", "class", "interface", etc. */
	symbolKind?: string
}

/**
 * CodeBlock extended with LSP enrichment data
 */
export interface EnrichedCodeBlock extends CodeBlock {
	/** LSP enrichment data (may be undefined if enrichment failed/skipped) */
	enrichment?: LSPEnrichmentData
	/** Content combined with type info for better embeddings */
	enrichedContent: string
}

/**
 * Interface for LSP client implementations
 */
export interface ILSPClient {
	/** Language identifier (e.g., "typescript", "csharp") */
	readonly languageId: string
	/** Current server status */
	readonly status: LSPServerStatus

	/**
	 * Initialize the LSP server for a workspace
	 * @param rootPath - Workspace root path
	 */
	initialize(rootPath: string): Promise<void>

	/**
	 * Get hover information at a position
	 * @returns Type signature and documentation, or null if unavailable
	 */
	getHoverInfo(
		filePath: string,
		line: number,
		character: number
	): Promise<{ typeSignature?: string; documentation?: string } | null>

	/**
	 * Notify the server that a document was opened
	 */
	openDocument(filePath: string, content: string): Promise<void>

	/**
	 * Notify the server that a document was closed
	 */
	closeDocument(filePath: string): Promise<void>

	/**
	 * Shutdown the LSP server
	 */
	shutdown(): Promise<void>
}

/**
 * LSP enrichment statistics
 */
export interface LSPStats {
	/** Total files processed with LSP enabled */
	filesProcessed: number
	/** Files where LSP was unavailable (server not ready) */
	filesSkippedUnavailable: number
	/** Files where language is not supported */
	filesSkippedUnsupported: number
	/** Files where LSP threw an error */
	filesWithErrors: number
	/** Total blocks processed */
	blocksProcessed: number
	/** Blocks successfully enriched with type info */
	blocksEnriched: number
	/** Blocks where LSP returned no data */
	blocksNoData: number
	/** Blocks served from cache */
	blocksFromCache: number
}

/**
 * Interface for the LSP enricher service
 */
export interface ILSPEnricher {
	/**
	 * Enrich code blocks with LSP data
	 * @param blocks - Code blocks from tree-sitter parsing
	 * @param filePath - Absolute path to the source file
	 * @returns Enriched blocks (with fallback to unenriched on error)
	 */
	enrichBlocks(blocks: CodeBlock[], filePath: string): Promise<EnrichedCodeBlock[]>

	/**
	 * Check if a file extension is supported for LSP enrichment
	 */
	isLanguageSupported(extension: string): boolean

	/**
	 * Get status of all LSP servers
	 */
	getStatus(): Map<string, LSPServerStatus>

	/**
	 * Get LSP enrichment statistics
	 */
	getStats(): LSPStats

	/**
	 * Reset LSP statistics
	 */
	resetStats(): void

	/**
	 * Shutdown all LSP servers
	 */
	shutdown(): Promise<void>
}

/**
 * Options for the LSP enricher
 */
export interface LSPEnricherOptions {
	/** Enable LSP enrichment (default: false) */
	enabled: boolean
	/** Timeout per hover request in ms (default: 5000) */
	timeout: number
	/** Maximum concurrent LSP requests (default: 5) */
	maxConcurrentRequests: number
	/** Return unenriched blocks on error instead of throwing (default: true) */
	fallbackOnError: boolean
}

/**
 * Default LSP enricher options
 */
export const DEFAULT_LSP_OPTIONS: LSPEnricherOptions = {
	enabled: false,
	timeout: 5000,
	maxConcurrentRequests: 5,
	fallbackOnError: true,
}

/**
 * Extension to language ID mapping
 */
export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "typescript",
	".jsx": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".mjs": "typescript",
	".cjs": "typescript",
	".cs": "csharp",
}

/**
 * Language ID to file extensions mapping
 */
export const LANGUAGE_TO_EXTENSIONS: Record<string, string[]> = {
	typescript: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
	csharp: [".cs"],
}
