/**
 * Embedder factory and interface exports
 */
import type { IEmbedder, EmbedderProvider, ServerConfig } from "../types/index.js"
import { OpenAiEmbedder } from "./openai.js"
import { OllamaEmbedder } from "./ollama.js"
import { OpenAICompatibleEmbedder } from "./openai-compatible.js"
import { GeminiEmbedder } from "./gemini.js"
import { MistralEmbedder } from "./mistral.js"
import { BedrockEmbedder } from "./bedrock.js"
import { OpenRouterEmbedder } from "./openrouter.js"

export * from "./openai.js"
export * from "./ollama.js"
export * from "./openai-compatible.js"
export * from "./gemini.js"
export * from "./mistral.js"
export * from "./bedrock.js"
export * from "./openrouter.js"

/**
 * Create an embedder based on the configuration
 */
export function createEmbedder(config: ServerConfig): IEmbedder {
	const provider = config.embedderProvider

	switch (provider) {
		case "openai":
			if (!config.openAiApiKey) {
				throw new Error("OpenAI API key is required for OpenAI embedder")
			}
			return new OpenAiEmbedder(config.openAiApiKey, config.modelId)

		case "ollama":
			return new OllamaEmbedder(config.ollamaBaseUrl, config.modelId)

		case "openai-compatible":
			if (!config.openAiCompatibleBaseUrl || !config.openAiCompatibleApiKey) {
				throw new Error("Base URL and API key are required for OpenAI-compatible embedder")
			}
			return new OpenAICompatibleEmbedder(
				config.openAiCompatibleBaseUrl,
				config.openAiCompatibleApiKey,
				config.modelId
			)

		case "gemini":
			if (!config.geminiApiKey) {
				throw new Error("Gemini API key is required for Gemini embedder")
			}
			return new GeminiEmbedder(config.geminiApiKey, config.modelId)

		case "mistral":
			if (!config.mistralApiKey) {
				throw new Error("Mistral API key is required for Mistral embedder")
			}
			return new MistralEmbedder(config.mistralApiKey, config.modelId)

		case "bedrock":
			if (!config.bedrockRegion) {
				throw new Error("AWS region is required for Bedrock embedder")
			}
			return new BedrockEmbedder(config.bedrockRegion, config.bedrockProfile, config.modelId)

		case "openrouter":
			if (!config.openRouterApiKey) {
				throw new Error("OpenRouter API key is required for OpenRouter embedder")
			}
			return new OpenRouterEmbedder(
				config.openRouterApiKey,
				config.modelId,
				undefined,
				config.openRouterSpecificProvider
			)

		default:
			throw new Error(`Unknown embedder provider: ${provider}`)
	}
}

/**
 * Get the default model ID for a provider
 */
export function getDefaultModelId(provider: EmbedderProvider): string {
	switch (provider) {
		case "openai":
			return "text-embedding-3-small"
		case "ollama":
			return "nomic-embed-text:latest"
		case "openai-compatible":
			return "text-embedding-3-small"
		case "gemini":
			return "gemini-embedding-001"
		case "mistral":
			return "codestral-embed-2505"
		case "bedrock":
			return "amazon.titan-embed-text-v2:0"
		case "openrouter":
			return "openai/text-embedding-3-large"
		default:
			return "text-embedding-3-small"
	}
}

/**
 * Get the default model dimension for a provider
 */
export function getDefaultModelDimension(provider: EmbedderProvider, modelId?: string): number {
	// Provider/model specific dimensions
	if (provider === "ollama") {
		if (modelId?.includes("nomic-embed-text")) return 768
		if (modelId?.includes("mxbai-embed-large")) return 1024
		return 768 // Default for Ollama
	}
	if (provider === "openai" || provider === "openai-compatible") {
		if (modelId?.includes("text-embedding-3-large")) return 3072
		if (modelId?.includes("text-embedding-3-small")) return 1536
		if (modelId?.includes("text-embedding-ada-002")) return 1536
		return 1536
	}
	if (provider === "gemini") {
		if (modelId?.includes("gemini-embedding-001")) return 2048
		if (modelId?.includes("text-embedding-004")) return 768
		return 768
	}
	if (provider === "mistral") {
		return 1536
	}
	if (provider === "bedrock") {
		if (modelId?.includes("titan-embed-text-v2")) return 1024
		if (modelId?.includes("titan-embed-text-v1")) return 1536
		if (modelId?.includes("cohere")) return 1024
		return 1024
	}
	if (provider === "openrouter") {
		if (modelId?.includes("text-embedding-3-large")) return 3072
		return 1536
	}
	return 1536 // Default
}
