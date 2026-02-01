import { z } from "zod"

export const EmbedderProviderSchema = z.enum([
	"openai",
	"ollama",
	"openai-compatible",
	"gemini",
	"mistral",
	"bedrock",
	"openrouter",
])

export const ServerConfigSchema = z.object({
	qdrantUrl: z.string().default("http://localhost:6333"),
	qdrantApiKey: z.string().optional(),
	embedderProvider: EmbedderProviderSchema.default("ollama"),
	modelId: z.string().optional(),
	modelDimension: z.number().optional(),
	openAiApiKey: z.string().optional(),
	ollamaBaseUrl: z.string().default("http://localhost:11434"),
	openAiCompatibleBaseUrl: z.string().optional(),
	openAiCompatibleApiKey: z.string().optional(),
	geminiApiKey: z.string().optional(),
	mistralApiKey: z.string().optional(),
	bedrockRegion: z.string().optional(),
	bedrockProfile: z.string().optional(),
	openRouterApiKey: z.string().optional(),
	openRouterSpecificProvider: z.string().optional(),
	searchMinScore: z.number().min(0).max(1).default(0.4),
	searchMaxResults: z.number().min(1).max(100).default(20),
	batchSize: z.number().min(1).max(200).default(60),
	fileWatcherPollInterval: z.number().min(50).max(5000).default(100),
	parsingConcurrency: z.number().min(1).max(50).default(10),
	// LSP enrichment options
	lspEnabled: z.boolean().default(true),
	lspTimeout: z.number().min(1000).max(30000).default(5000),
	lspMaxConcurrentRequests: z.number().min(1).max(20).default(5),
	lspUseOmniSharp: z.boolean().default(false),
	// Model context sizes (model name -> max tokens)
	modelContextSizes: z.record(z.string(), z.number()).default({
		// Ollama models
		"nomic-embed-text": 8192,
		"mxbai-embed-large": 512,
		"all-minilm": 256,
		"snowflake-arctic-embed": 512,
		"bge-large": 512,
		"bge-m3": 8192,
		// OpenAI models
		"text-embedding-3-small": 8191,
		"text-embedding-3-large": 8191,
		"text-embedding-ada-002": 8191,
		// Gemini models
		"text-embedding-004": 2048,
		"embedding-001": 2048,
		// Mistral models
		"mistral-embed": 8192,
		// Voyage AI (via OpenAI-compatible)
		"voyage-code-2": 16000,
		"voyage-large-2": 16000,
	}),
})

export const FolderStatusSchema = z.enum(["pending", "indexing", "indexed", "error", "paused"])

export const IndexedFolderSchema = z.object({
	id: z.string(),
	path: z.string(),
	name: z.string(),
	status: FolderStatusSchema.default("pending"),
	addedAt: z.number(),
	lastIndexedAt: z.number().optional(),
	fileCount: z.number().optional(),
	errorCount: z.number().optional(),
	lastError: z.string().optional(),
	// Worktree support
	isWorktree: z.boolean().optional(),
	baseRepoId: z.string().optional(),      // Links to the base repo's folder ID
	gitCommonDir: z.string().optional(),    // Path to shared .git directory
	isOrphaned: z.boolean().optional(),     // True if folder no longer exists on disk
	// Per-folder settings
	lspEnabled: z.boolean().optional(),     // LSP enrichment (undefined = use global default, which is enabled)
	lastIndexedWithLsp: z.boolean().optional(), // Whether LSP was enabled during last indexing
	// Per-folder embedding model (undefined = use global default)
	embeddingModel: z.string().optional(),
	lastIndexedWithModel: z.string().optional(), // Model used during last indexing
})

export const FoldersConfigSchema = z.object({
	folders: z.array(IndexedFolderSchema).default([]),
})

export type ServerConfigInput = z.input<typeof ServerConfigSchema>
export type ServerConfigOutput = z.output<typeof ServerConfigSchema>
export type IndexedFolderInput = z.input<typeof IndexedFolderSchema>
export type IndexedFolderOutput = z.output<typeof IndexedFolderSchema>
export type FoldersConfigInput = z.input<typeof FoldersConfigSchema>
export type FoldersConfigOutput = z.output<typeof FoldersConfigSchema>
