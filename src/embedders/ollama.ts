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

	constructor(baseUrl?: string, modelId?: string) {
		let url = baseUrl || "http://localhost:11434"
		// Normalize the baseUrl by removing all trailing slashes
		url = url.replace(/\/+$/, "")
		this.baseUrl = url
		this.defaultModelId = modelId || "nomic-embed-text:latest"
	}

	async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
		const modelToUse = model || this.defaultModelId
		const url = `${this.baseUrl}/api/embed`

		// Track which texts are valid and which are skipped
		const validIndices: number[] = []
		const processedTexts: string[] = []

		texts.forEach((text, index) => {
			const estimatedTokens = Math.ceil(text.length / 4)
			if (estimatedTokens > MAX_ITEM_TOKENS) {
				console.warn(`Text at index ${index} exceeds token limit (${estimatedTokens} > ${MAX_ITEM_TOKENS}), skipping`)
			} else {
				validIndices.push(index)
				processedTexts.push(text)
			}
		})

		// If all texts were filtered out, return empty embeddings array matching input length
		if (processedTexts.length === 0) {
			return { embeddings: texts.map(() => []) }
		}

		try {
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), OLLAMA_EMBEDDING_TIMEOUT_MS)

			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: modelToUse,
					input: processedTexts,
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

			// Reconstruct embeddings array with empty arrays for skipped texts
			const embeddings: number[][] = texts.map(() => [])
			validIndices.forEach((originalIndex, embeddingIndex) => {
				embeddings[originalIndex] = rawEmbeddings[embeddingIndex]
			})

			return { embeddings }
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
