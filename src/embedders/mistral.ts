import type { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../types/index.js"
import { OpenAICompatibleEmbedder } from "./openai-compatible.js"
import { MAX_ITEM_TOKENS } from "./constants.js"

/**
 * Mistral embedder implementation that wraps the OpenAI Compatible embedder
 */
export class MistralEmbedder implements IEmbedder {
	private readonly openAICompatibleEmbedder: OpenAICompatibleEmbedder
	private static readonly MISTRAL_BASE_URL = "https://api.mistral.ai/v1"
	private static readonly DEFAULT_MODEL = "codestral-embed-2505"
	private readonly modelId: string

	constructor(apiKey: string, modelId?: string) {
		if (!apiKey) {
			throw new Error("Mistral API key is required")
		}

		this.modelId = modelId || MistralEmbedder.DEFAULT_MODEL
		this.openAICompatibleEmbedder = new OpenAICompatibleEmbedder(
			MistralEmbedder.MISTRAL_BASE_URL,
			apiKey,
			this.modelId,
			MAX_ITEM_TOKENS
		)
	}

	async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
		const modelToUse = model || this.modelId
		return await this.openAICompatibleEmbedder.createEmbeddings(texts, modelToUse)
	}

	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return await this.openAICompatibleEmbedder.validateConfiguration()
	}

	get embedderInfo(): EmbedderInfo {
		return { name: "mistral" }
	}
}
