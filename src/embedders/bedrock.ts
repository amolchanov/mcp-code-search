import { BedrockRuntimeClient, InvokeModelCommand, InvokeModelCommandInput } from "@aws-sdk/client-bedrock-runtime"
import { fromEnv, fromIni } from "@aws-sdk/credential-providers"
import type { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../types/index.js"
import {
	MAX_BATCH_TOKENS,
	MAX_ITEM_TOKENS,
	MAX_BATCH_RETRIES,
	INITIAL_RETRY_DELAY_MS,
} from "./constants.js"

/**
 * Amazon Bedrock implementation of the embedder interface
 */
export class BedrockEmbedder implements IEmbedder {
	private bedrockClient: BedrockRuntimeClient
	private readonly defaultModelId: string

	constructor(
		private readonly region: string,
		private readonly profile?: string,
		modelId?: string
	) {
		if (!region) {
			throw new Error("AWS region is required for Bedrock embedder")
		}

		const credentials = this.profile ? fromIni({ profile: this.profile }) : fromEnv()

		this.bedrockClient = new BedrockRuntimeClient({
			region: this.region,
			credentials,
		})

		this.defaultModelId = modelId || "amazon.titan-embed-text-v2:0"
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
				const embeddings: number[][] = []
				let totalPromptTokens = 0
				let totalTokens = 0

				// Bedrock models typically don't support batch embedding, process individually
				for (const text of batchTexts) {
					const embedding = await this._invokeEmbeddingModel(text, model)
					embeddings.push(embedding.embedding)
					totalPromptTokens += embedding.inputTextTokenCount || 0
					totalTokens += embedding.inputTextTokenCount || 0
				}

				return {
					embeddings,
					usage: {
						promptTokens: totalPromptTokens,
						totalTokens,
					},
				}
			} catch (error: unknown) {
				const hasMoreAttempts = attempts < MAX_BATCH_RETRIES - 1
				const err = error as { name?: string }

				if (err.name === "ThrottlingException" && hasMoreAttempts) {
					const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempts)
					console.warn(`Rate limit hit, retrying in ${delayMs}ms (attempt ${attempts + 1}/${MAX_BATCH_RETRIES})`)
					await new Promise((resolve) => setTimeout(resolve, delayMs))
					continue
				}

				console.error(`Bedrock embedder error (attempt ${attempts + 1}/${MAX_BATCH_RETRIES}):`, error)
				throw error
			}
		}

		throw new Error(`Failed to create embeddings after ${MAX_BATCH_RETRIES} attempts`)
	}

	private async _invokeEmbeddingModel(
		text: string,
		model: string
	): Promise<{ embedding: number[]; inputTextTokenCount?: number }> {
		let requestBody: Record<string, unknown>

		if (model.startsWith("amazon.nova-2-multimodal")) {
			requestBody = {
				taskType: "SINGLE_EMBEDDING",
				singleEmbeddingParams: {
					embeddingPurpose: "GENERIC_INDEX",
					embeddingDimension: 1024,
					text: {
						truncationMode: "END",
						value: text,
					},
				},
			}
		} else if (model.startsWith("amazon.titan-embed")) {
			requestBody = { inputText: text }
		} else if (model.startsWith("cohere.embed")) {
			requestBody = {
				texts: [text],
				input_type: "search_document",
			}
		} else {
			requestBody = { inputText: text }
		}

		const params: InvokeModelCommandInput = {
			modelId: model,
			body: JSON.stringify(requestBody),
			contentType: "application/json",
			accept: "application/json",
		}

		const command = new InvokeModelCommand(params)
		const response = await this.bedrockClient.send(command)

		const responseBody = JSON.parse(new TextDecoder().decode(response.body)) as {
			embedding?: number[]
			embeddings?: Array<{ embedding?: number[] } | number[]>
			inputTextTokenCount?: number
		}

		if (model.startsWith("amazon.nova-2-multimodal")) {
			return {
				embedding: responseBody.embeddings?.[0] && typeof responseBody.embeddings[0] === "object" && "embedding" in responseBody.embeddings[0]
					? (responseBody.embeddings[0] as { embedding: number[] }).embedding
					: responseBody.embedding || [],
				inputTextTokenCount: responseBody.inputTextTokenCount,
			}
		} else if (model.startsWith("amazon.titan-embed")) {
			return {
				embedding: responseBody.embedding || [],
				inputTextTokenCount: responseBody.inputTextTokenCount,
			}
		} else if (model.startsWith("cohere.embed")) {
			return {
				embedding: Array.isArray(responseBody.embeddings?.[0]) ? responseBody.embeddings[0] as number[] : [],
			}
		} else {
			return {
				embedding: responseBody.embedding || [],
				inputTextTokenCount: responseBody.inputTextTokenCount,
			}
		}
	}

	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		try {
			const result = await this._invokeEmbeddingModel("test", this.defaultModelId)

			if (!result.embedding || result.embedding.length === 0) {
				return { valid: false, error: "Invalid response format from Bedrock" }
			}

			return { valid: true }
		} catch (error: unknown) {
			const err = error as { name?: string; message?: string }
			if (err.name === "UnrecognizedClientException") {
				return { valid: false, error: "Invalid AWS credentials" }
			}
			if (err.name === "AccessDeniedException") {
				return { valid: false, error: "Access denied to Bedrock" }
			}
			if (err.name === "ResourceNotFoundException") {
				return { valid: false, error: `Model not found: ${this.defaultModelId}` }
			}
			return { valid: false, error: err.message || "Unknown error" }
		}
	}

	get embedderInfo(): EmbedderInfo {
		return { name: "bedrock" }
	}
}
