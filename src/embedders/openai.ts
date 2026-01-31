import { OpenAI } from "openai"
import type { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../types/index.js"
import {
	MAX_BATCH_TOKENS,
	MAX_ITEM_TOKENS,
	MAX_BATCH_RETRIES,
	INITIAL_RETRY_DELAY_MS,
} from "./constants.js"

interface HttpError extends Error {
	status?: number
}

/**
 * OpenAI implementation of the embedder interface
 */
export class OpenAiEmbedder implements IEmbedder {
	private embeddingsClient: OpenAI
	private readonly defaultModelId: string

	constructor(apiKey: string, modelId?: string) {
		if (!apiKey) {
			throw new Error("OpenAI API key is required")
		}
		this.embeddingsClient = new OpenAI({ apiKey })
		this.defaultModelId = modelId || "text-embedding-3-small"
	}

	async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
		const modelToUse = model || this.defaultModelId
		const allEmbeddings: number[][] = []
		const usage = { promptTokens: 0, totalTokens: 0 }
		const remainingTexts = [...texts]

		while (remainingTexts.length > 0) {
			const currentBatch: string[] = []
			let currentBatchTokens = 0
			const processedIndices: number[] = []

			for (let i = 0; i < remainingTexts.length; i++) {
				const text = remainingTexts[i]
				const itemTokens = Math.ceil(text.length / 4)

				if (itemTokens > MAX_ITEM_TOKENS) {
					console.warn(`Text at index ${i} exceeds token limit (${itemTokens} > ${MAX_ITEM_TOKENS}), skipping`)
					processedIndices.push(i)
					continue
				}

				if (currentBatchTokens + itemTokens <= MAX_BATCH_TOKENS) {
					currentBatch.push(text)
					currentBatchTokens += itemTokens
					processedIndices.push(i)
				} else {
					break
				}
			}

			for (let i = processedIndices.length - 1; i >= 0; i--) {
				remainingTexts.splice(processedIndices[i], 1)
			}

			if (currentBatch.length > 0) {
				const batchResult = await this._embedBatchWithRetries(currentBatch, modelToUse)
				allEmbeddings.push(...batchResult.embeddings)
				usage.promptTokens += batchResult.usage.promptTokens
				usage.totalTokens += batchResult.usage.totalTokens
			}
		}

		return { embeddings: allEmbeddings, usage }
	}

	private async _embedBatchWithRetries(
		batchTexts: string[],
		model: string
	): Promise<{ embeddings: number[][]; usage: { promptTokens: number; totalTokens: number } }> {
		for (let attempts = 0; attempts < MAX_BATCH_RETRIES; attempts++) {
			try {
				const response = await this.embeddingsClient.embeddings.create({
					input: batchTexts,
					model: model,
				})

				return {
					embeddings: response.data.map((item) => item.embedding),
					usage: {
						promptTokens: response.usage?.prompt_tokens || 0,
						totalTokens: response.usage?.total_tokens || 0,
					},
				}
			} catch (error: unknown) {
				const hasMoreAttempts = attempts < MAX_BATCH_RETRIES - 1
				const httpError = error as HttpError

				if (httpError?.status === 429 && hasMoreAttempts) {
					const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempts)
					console.warn(`Rate limit hit, retrying in ${delayMs}ms (attempt ${attempts + 1}/${MAX_BATCH_RETRIES})`)
					await new Promise((resolve) => setTimeout(resolve, delayMs))
					continue
				}

				console.error(`OpenAI embedder error (attempt ${attempts + 1}/${MAX_BATCH_RETRIES}):`, error)
				throw error
			}
		}

		throw new Error(`Failed to create embeddings after ${MAX_BATCH_RETRIES} attempts`)
	}

	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		try {
			const response = await this.embeddingsClient.embeddings.create({
				input: ["test"],
				model: this.defaultModelId,
			})

			if (!response.data || response.data.length === 0) {
				return { valid: false, error: "Invalid response format from OpenAI" }
			}

			return { valid: true }
		} catch (error: unknown) {
			const httpError = error as HttpError
			if (httpError?.status === 401) {
				return { valid: false, error: "Invalid API key" }
			}
			if (httpError?.status === 404) {
				return { valid: false, error: "Model not found" }
			}
			return { valid: false, error: error instanceof Error ? error.message : "Unknown error" }
		}
	}

	get embedderInfo(): EmbedderInfo {
		return { name: "openai" }
	}
}
