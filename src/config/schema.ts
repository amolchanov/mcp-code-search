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
