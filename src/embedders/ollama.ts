import type { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../types/index.js"
import {
	MAX_ITEM_TOKENS,
	OLLAMA_EMBEDDING_TIMEOUT_MS,
	OLLAMA_VALIDATION_TIMEOUT_MS,
} from "./constants.js"

/**
 * Ollama implementation of the embedder interface
 */
export class OllamaEmbedder implements IEmbedder {
	private readonly baseUrl: string
	private readonly defaultModelId: string
	private maxContextTokens: number

	constructor(baseUrl?: string, modelId?: string, maxContextTokens?: number) {
		let url = baseUrl || "http://localhost:11434"
		// Normalize the baseUrl by removing all trailing slashes
		url = url.replace(/\/+$/, "")
		this.baseUrl = url
		this.defaultModelId = modelId || "nomic-embed-text:latest"
		this.maxContextTokens = maxContextTokens || 8192
	}

	setMaxContextTokens(tokens: number): void {
		this.maxContextTokens = tokens
	}

	async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
		const modelToUse = model || this.defaultModelId

		// Use very conservative limit - half of context tokens as chars
		// This accounts for tokenizer overhead and special characters
		const MAX_SAFE_CHARS_PER_TEXT = Math.floor(this.maxContextTokens / 2)
		// Total batch size limit - keep it small to avoid hitting Ollama's limit
		const MAX_BATCH_CHARS = this.maxContextTokens * 2 // 2x single text limit for entire batch

		// Track which texts are valid and which are skipped
		const validIndices: number[] = []
		const processedTexts: string[] = []

		texts.forEach((text, index) => {
			// Skip undefined/null/empty texts
			if (!text || typeof text !== "string") {
				console.warn(`Text at index ${index} is invalid (${typeof text}), skipping`)
				return
			}

			let processedText = text
			if (text.length > MAX_SAFE_CHARS_PER_TEXT) {
				// Truncate to fit within context, preserving beginning of code
				processedText = text.slice(0, MAX_SAFE_CHARS_PER_TEXT) + "\n// [truncated]"
				console.warn(`Text at index ${index} truncated from ${text.length} to ${MAX_SAFE_CHARS_PER_TEXT} chars`)
			}

			validIndices.push(index)
			processedTexts.push(processedText)
		})

		// If all texts were filtered out, return empty embeddings array matching input length
		if (processedTexts.length === 0) {
			return { embeddings: texts.map(() => []) }
		}

		// Split into smaller batches if total size exceeds limit
		const batches: { texts: string[]; indices: number[] }[] = []
		let currentBatch: string[] = []
		let currentIndices: number[] = []
		let currentBatchSize = 0

		for (let i = 0; i < processedTexts.length; i++) {
			const text = processedTexts[i]
			if (currentBatchSize + text.length > MAX_BATCH_CHARS && currentBatch.length > 0) {
				// Start a new batch
				batches.push({ texts: currentBatch, indices: currentIndices })
				currentBatch = []
				currentIndices = []
				currentBatchSize = 0
			}
			currentBatch.push(text)
			currentIndices.push(validIndices[i])
			currentBatchSize += text.length
		}
		if (currentBatch.length > 0) {
			batches.push({ texts: currentBatch, indices: currentIndices })
		}

		// Process each batch
		const embeddings: number[][] = texts.map(() => [])

		for (const batch of batches) {
			const batchEmbeddings = await this.processBatch(batch.texts, modelToUse)
			batch.indices.forEach((originalIndex, embeddingIndex) => {
				embeddings[originalIndex] = batchEmbeddings[embeddingIndex]
			})
		}

		return { embeddings }
	}

	private async processBatch(texts: string[], model: string): Promise<number[][]> {
		const url = `${this.baseUrl}/api/embed`

		try {
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), OLLAMA_EMBEDDING_TIMEOUT_MS)

			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					input: texts,
				}),
				signal: controller.signal,
			})
			clearTimeout(timeoutId)

			if (!response.ok) {
				let errorBody = "Could not read error body"
				try {
					errorBody = await response.text()
				} catch {
					// Ignore error reading body
				}
				throw new Error(`Ollama request failed: ${response.status} ${response.statusText} - ${errorBody}`)
			}

			const data = await response.json() as { embeddings?: number[][] }
			const rawEmbeddings = data.embeddings
			if (!rawEmbeddings || !Array.isArray(rawEmbeddings)) {
				throw new Error("Invalid response structure from Ollama - missing embeddings array")
			}

			return rawEmbeddings
		} catch (error: unknown) {
			console.error("Ollama embedding failed:", error)

			if (error instanceof Error) {
				if (error.name === "AbortError") {
					throw new Error("Ollama request timed out")
				}
				if (error.message?.includes("fetch failed") || (error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
					throw new Error(`Ollama service not running at ${this.baseUrl}`)
				}
				if ((error as NodeJS.ErrnoException).code === "ENOTFOUND") {
					throw new Error(`Ollama host not found: ${this.baseUrl}`)
				}
			}

			throw new Error(`Ollama embedding failed: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		try {
			// First check if Ollama service is running by listing models
			const modelsUrl = `${this.baseUrl}/api/tags`
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), OLLAMA_VALIDATION_TIMEOUT_MS)

			const modelsResponse = await fetch(modelsUrl, {
				method: "GET",
				headers: { "Content-Type": "application/json" },
				signal: controller.signal,
			})
			clearTimeout(timeoutId)

			if (!modelsResponse.ok) {
				if (modelsResponse.status === 404) {
					return { valid: false, error: `Ollama service not running at ${this.baseUrl}` }
				}
				return { valid: false, error: `Ollama service unavailable at ${this.baseUrl} (${modelsResponse.status})` }
			}

			// Check if the specific model exists
			const modelsData = await modelsResponse.json() as { models?: Array<{ name?: string }> }
			const models = modelsData.models || []

			const modelExists = models.some((m) => {
				const modelName = m.name || ""
				return (
					modelName === this.defaultModelId ||
					modelName === `${this.defaultModelId}:latest` ||
					modelName === this.defaultModelId.replace(":latest", "")
				)
			})

			if (!modelExists) {
				const availableModels = models.map((m) => m.name).join(", ")
				return {
					valid: false,
					error: `Model '${this.defaultModelId}' not found. Available models: ${availableModels || "none"}`,
				}
			}

			// Try a test embedding
			const testUrl = `${this.baseUrl}/api/embed`
			const testController = new AbortController()
			const testTimeoutId = setTimeout(() => testController.abort(), OLLAMA_VALIDATION_TIMEOUT_MS)

			const testResponse = await fetch(testUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: this.defaultModelId,
					input: ["test"],
				}),
				signal: testController.signal,
			})
			clearTimeout(testTimeoutId)

			if (!testResponse.ok) {
				return { valid: false, error: `Model '${this.defaultModelId}' is not embedding-capable` }
			}

			return { valid: true }
		} catch (error: unknown) {
			if (error instanceof Error) {
				if (error.message?.includes("fetch failed") || (error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
					return { valid: false, error: `Ollama service not running at ${this.baseUrl}` }
				}
				if ((error as NodeJS.ErrnoException).code === "ENOTFOUND") {
					return { valid: false, error: `Ollama host not found: ${this.baseUrl}` }
				}
				if (error.name === "AbortError") {
					return { valid: false, error: "Connection to Ollama timed out" }
				}
			}
			return { valid: false, error: error instanceof Error ? error.message : "Unknown error" }
		}
	}

	get embedderInfo(): EmbedderInfo {
		return { name: "ollama" }
	}
}
