import { z } from "zod"
import { loadServerConfig, saveServerConfig } from "../config/store.js"
import { EmbedderProviderSchema } from "../config/schema.js"

export const ConfigureSchema = z.object({
	qdrantUrl: z.string().optional().describe("Qdrant server URL"),
	qdrantApiKey: z.string().optional().describe("Qdrant API key"),
	embedderProvider: EmbedderProviderSchema.optional().describe("Embedding provider to use"),
	modelId: z.string().optional().describe("Model ID for embeddings"),
	modelDimension: z.number().optional().describe("Embedding dimension"),
	openAiApiKey: z.string().optional().describe("OpenAI API key"),
	ollamaBaseUrl: z.string().optional().describe("Ollama base URL"),
	openAiCompatibleBaseUrl: z.string().optional().describe("OpenAI-compatible API base URL"),
	openAiCompatibleApiKey: z.string().optional().describe("OpenAI-compatible API key"),
	geminiApiKey: z.string().optional().describe("Google Gemini API key"),
	mistralApiKey: z.string().optional().describe("Mistral API key"),
	bedrockRegion: z.string().optional().describe("AWS Bedrock region"),
	bedrockProfile: z.string().optional().describe("AWS profile name"),
	openRouterApiKey: z.string().optional().describe("OpenRouter API key"),
	openRouterSpecificProvider: z.string().optional().describe("OpenRouter specific provider"),
	searchMinScore: z.number().min(0).max(1).optional().describe("Minimum search score threshold"),
	searchMaxResults: z.number().min(1).max(100).optional().describe("Maximum search results"),
	batchSize: z.number().min(1).max(200).optional().describe("Embedding batch size"),
})

export async function configure(args: z.infer<typeof ConfigureSchema>): Promise<string> {
	try {
		// Filter out undefined values
		const updates: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(args)) {
			if (value !== undefined) {
				updates[key] = value
			}
		}

		if (Object.keys(updates).length === 0) {
			// No updates, return current config
			const config = await loadServerConfig()

			// Mask sensitive values
			const maskedConfig = {
				...config,
				openAiApiKey: config.openAiApiKey ? "***" : undefined,
				qdrantApiKey: config.qdrantApiKey ? "***" : undefined,
				openAiCompatibleApiKey: config.openAiCompatibleApiKey ? "***" : undefined,
				geminiApiKey: config.geminiApiKey ? "***" : undefined,
				mistralApiKey: config.mistralApiKey ? "***" : undefined,
				openRouterApiKey: config.openRouterApiKey ? "***" : undefined,
			}

			return JSON.stringify({
				success: true,
				message: "Current configuration (no changes made)",
				config: maskedConfig,
			})
		}

		const newConfig = await saveServerConfig(updates)

		// Mask sensitive values in response
		const maskedConfig = {
			...newConfig,
			openAiApiKey: newConfig.openAiApiKey ? "***" : undefined,
			qdrantApiKey: newConfig.qdrantApiKey ? "***" : undefined,
			openAiCompatibleApiKey: newConfig.openAiCompatibleApiKey ? "***" : undefined,
			geminiApiKey: newConfig.geminiApiKey ? "***" : undefined,
			mistralApiKey: newConfig.mistralApiKey ? "***" : undefined,
			openRouterApiKey: newConfig.openRouterApiKey ? "***" : undefined,
		}

		return JSON.stringify({
			success: true,
			message: "Configuration updated successfully. Restart the server for changes to take effect.",
			config: maskedConfig,
		})
	} catch (error) {
		return JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

export async function getConfig(): Promise<string> {
	try {
		const config = await loadServerConfig()

		// Mask sensitive values
		const maskedConfig = {
			...config,
			openAiApiKey: config.openAiApiKey ? "***" : undefined,
			qdrantApiKey: config.qdrantApiKey ? "***" : undefined,
			openAiCompatibleApiKey: config.openAiCompatibleApiKey ? "***" : undefined,
			geminiApiKey: config.geminiApiKey ? "***" : undefined,
			mistralApiKey: config.mistralApiKey ? "***" : undefined,
			openRouterApiKey: config.openRouterApiKey ? "***" : undefined,
		}

		return JSON.stringify({
			success: true,
			config: maskedConfig,
		})
	} catch (error) {
		return JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}
