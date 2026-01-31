import type { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../types/index.js"
import { OpenAICompatibleEmbedder } from "./openai-compatible.js"
import { GEMINI_MAX_ITEM_TOKENS } from "./constants.js"

/**
 * Gemini embedder implementation that wraps the OpenAI Compatible embedder
 */
export class GeminiEmbedder implements IEmbedder {
	private readonly openAICompatibleEmbedder: OpenAICompatibleEmbedder
	private static readonly GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
	private static readonly DEFAULT_MODEL = "gemini-embedding-001"
	private readonly modelId: string

	constructor(apiKey: string, modelId?: string) {
		if (!apiKey) {
			throw new Error("Gemini API key is required")
		}

		this.modelId = modelId || GeminiEmbedder.DEFAULT_MODEL
		this.openAICompatibleEmbedder = new OpenAICompatibleEmbedder(
			GeminiEmbedder.GEMINI_BASE_URL,
			apiKey,
			this.modelId,
			GEMINI_MAX_ITEM_TOKENS
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
		return { name: "gemini" }
	}
}
