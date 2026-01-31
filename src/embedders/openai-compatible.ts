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

interface EmbeddingItem {
	embedding: string | number[]
	[key: string]: unknown
}

interface OpenAIEmbeddingResponse {
	data: EmbeddingItem[]
	usage?: {
		prompt_tokens?: number
		total_tokens?: number
	}
}

/**
 * OpenAI Compatible implementation of the embedder interface
 */
export class OpenAICompatibleEmbedder implements IEmbedder {
	private embeddingsClient: OpenAI
	private readonly defaultModelId: string
	private readonly baseUrl: string
	private readonly apiKey: string
	private readonly isFullUrl: boolean
	private readonly maxItemTokens: number

	constructor(baseUrl: string, apiKey: string, modelId?: string, maxItemTokens?: number) {
		if (!baseUrl) {
			throw new Error("Base URL is required for OpenAI-compatible embedder")
		}
		if (!apiKey) {
			throw new Error("API key is required for OpenAI-compatible embedder")
		}

		this.baseUrl = baseUrl
		this.apiKey = apiKey
		this.embeddingsClient = new OpenAI({
			baseURL: baseUrl,
			apiKey: apiKey,
		})
		this.defaultModelId = modelId || "text-embedding-3-small"
		this.isFullUrl = this.isFullEndpointUrl(baseUrl)
		this.maxItemTokens = maxItemTokens || MAX_ITEM_TOKENS
	}

	private isFullEndpointUrl(url: string): boolean {
		const patterns = [
			/\/deployments\/[^\/]+\/embeddings(\?|$)/,
			/\/serving-endpoints\/[^\/]+\/invocations(\?|$)/,
			/\/embeddings(\?|$)/,
			/\/embed(\?|$)/,
		]
		return patterns.some((pattern) => pattern.test(url))
	}

	private async makeDirectEmbeddingRequest(
		url: string,
		batchTexts: string[],
		model: string
	): Promise<OpenAIEmbeddingResponse> {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"api-key": this.apiKey,
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				input: batchTexts,
				model: model,
				encoding_format: "base64",
			}),
		})

		if (!response || !response.ok) {
			const status = response?.status || 0
			let errorText = "No response"
			try {
				if (response && typeof response.text === "function") {
					errorText = await response.text()
				}
			} catch {
				errorText = `Error ${status}`
			}
			const error = new Error(`HTTP ${status}: ${errorText}`) as HttpError
			error.status = status
			throw error
		}

		return await response.json() as OpenAIEmbeddingResponse
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

				if (itemTokens > this.maxItemTokens) {
					console.warn(`Text at index ${i} exceeds token limit (${itemTokens} > ${this.maxItemTokens}), skipping`)
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
				let response: OpenAIEmbeddingResponse

				if (this.isFullUrl) {
					response = await this.makeDirectEmbeddingRequest(this.baseUrl, batchTexts, model)
				} else {
					response = (await this.embeddingsClient.embeddings.create({
						input: batchTexts,
						model: model,
						encoding_format: "base64",
					})) as unknown as OpenAIEmbeddingResponse
				}

				// Convert base64 embeddings to float32 arrays
				const processedEmbeddings = response.data.map((item: EmbeddingItem) => {
					if (typeof item.embedding === "string") {
						const buffer = Buffer.from(item.embedding, "base64")
						const float32Array = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
						return Array.from(float32Array)
					}
					return item.embedding as number[]
				})

				return {
					embeddings: processedEmbeddings,
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

				console.error(`OpenAI Compatible embedder error (attempt ${attempts + 1}/${MAX_BATCH_RETRIES}):`, error)
				throw error
			}
		}

		throw new Error(`Failed to create embeddings after ${MAX_BATCH_RETRIES} attempts`)
	}

	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		try {
			let response: OpenAIEmbeddingResponse

			if (this.isFullUrl) {
				response = await this.makeDirectEmbeddingRequest(this.baseUrl, ["test"], this.defaultModelId)
			} else {
				response = (await this.embeddingsClient.embeddings.create({
					input: ["test"],
					model: this.defaultModelId,
					encoding_format: "base64",
				})) as unknown as OpenAIEmbeddingResponse
			}

			if (!response?.data || response.data.length === 0) {
				return { valid: false, error: "Invalid response from server" }
			}

			return { valid: true }
		} catch (error: unknown) {
			const httpError = error as HttpError
			if (httpError?.status === 401) {
				return { valid: false, error: "Invalid API key" }
			}
			if (httpError?.status === 404) {
				return { valid: false, error: "Invalid endpoint or model not found" }
			}
			return { valid: false, error: error instanceof Error ? error.message : "Unknown error" }
		}
	}

	get embedderInfo(): EmbedderInfo {
		return { name: "openai-compatible" }
	}
}
