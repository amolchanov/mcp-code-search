/**
 * Type definitions for the Code Search MCP Server
 */

// Embedder types
export type EmbedderProvider =
	| "openai"
	| "ollama"
	| "openai-compatible"
	| "gemini"
	| "mistral"
	| "bedrock"
	| "openrouter"

export interface EmbeddingResponse {
	embeddings: number[][]
	usage?: {
		promptTokens: number
		totalTokens: number
	}
}

export interface EmbedderInfo {
	name: EmbedderProvider
}

export interface IEmbedder {
	createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse>
	validateConfiguration(): Promise<{ valid: boolean; error?: string }>
	setMaxContextTokens?(tokens: number): void
	readonly embedderInfo: EmbedderInfo
}

// Vector store types
export interface PointStruct {
	id: string
	vector: number[]
	payload: Record<string, unknown>
}

export interface VectorStoreSearchResult {
	id: string | number
	score: number
	payload?: Payload | null
}

export interface Payload {
	filePath: string
	codeChunk: string
	startLine: number
	endLine: number
	folderId: string
	[key: string]: unknown
}

export interface IVectorStore {
	initialize(): Promise<boolean>
	upsertPoints(points: PointStruct[]): Promise<void>
	search(
		queryVector: number[],
		filter?: SearchFilter,
		minScore?: number,
		maxResults?: number
	): Promise<VectorStoreSearchResult[]>
	deletePointsByFilePath(filePath: string, folderId: string): Promise<void>
	deletePointsByMultipleFilePaths(filePaths: string[], folderId: string): Promise<void>
	deletePointsByFolderId(folderId: string): Promise<void>
	clearCollection(): Promise<void>
	deleteCollection(): Promise<void>
	collectionExists(): Promise<boolean>
	hasIndexedData(): Promise<boolean>
	markIndexingComplete(folderId: string): Promise<void>
	markIndexingIncomplete(folderId: string): Promise<void>
	getPointCountForFolder?(folderId: string): Promise<number>
}

export interface SearchFilter {
	folderId?: string
	fileTypes?: string[]
	pathPrefix?: string
}

// Code parser types
export interface ParentContext {
	className?: string
	moduleName?: string
	parentFunction?: string
	namespace?: string
}

export interface CodeBlock {
	file_path: string
	identifier: string | null
	type: string
	start_line: number
	end_line: number
	content: string
	segmentHash: string
	fileHash: string
	// Parent context for hierarchical code understanding
	parentContext?: ParentContext
}

export interface ICodeParser {
	parseFile(
		filePath: string,
		options?: { content?: string; fileHash?: string }
	): Promise<CodeBlock[]>
}

// Folder management types
export type FolderStatus = "pending" | "indexing" | "indexed" | "error" | "paused"

export interface IndexedFolder {
	id: string
	path: string
	name: string
	status: FolderStatus
	addedAt: number
	lastIndexedAt?: number
	fileCount?: number
	errorCount?: number
	lastError?: string
	// Worktree support
	isWorktree?: boolean
	baseRepoId?: string       // Links to the base repo's folder ID
	gitCommonDir?: string     // Path to shared .git directory
	isOrphaned?: boolean      // True if folder no longer exists on disk
	// Per-folder settings
	lspEnabled?: boolean      // Override global LSP setting for this folder
	embeddingModel?: string   // Per-folder embedding model
	includeExtensions?: string[]  // File extensions to index (e.g., ['.ts', '.js'])
}

export interface FolderProgress {
	folderId: string
	status: FolderStatus
	processedFiles: number
	totalFiles: number
	indexedBlocks: number
	currentFile?: string
	startTime?: number
	endTime?: number
}

export interface IndexingError {
	folderId: string
	filePath: string
	error: string
	timestamp: number
}

// Configuration types
export interface ServerConfig {
	qdrantUrl: string
	qdrantApiKey?: string
	embedderProvider: EmbedderProvider
	modelId?: string
	modelDimension?: number
	openAiApiKey?: string
	ollamaBaseUrl?: string
	openAiCompatibleBaseUrl?: string
	openAiCompatibleApiKey?: string
	geminiApiKey?: string
	mistralApiKey?: string
	bedrockRegion?: string
	bedrockProfile?: string
	openRouterApiKey?: string
	openRouterSpecificProvider?: string
	searchMinScore?: number
	searchMaxResults?: number
	batchSize?: number
	modelContextSizes?: Record<string, number>
}

// Cache types
export interface FileCache {
	[filePath: string]: string // hash
}

export interface ICacheManager {
	initialize(): Promise<void>
	getHash(filePath: string): string | undefined
	updateHash(filePath: string, hash: string): Promise<void>
	deleteHash(filePath: string): Promise<void>
	getAllHashes(): Record<string, string>
	getFileCount(): number
	clearCacheFile(): Promise<void>
}
