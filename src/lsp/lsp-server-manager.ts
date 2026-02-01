import * as path from "path"
import type { ILSPClient, LSPServerStatus } from "./types.js"
import { EXTENSION_TO_LANGUAGE } from "./types.js"
import { TypeScriptLSPClient } from "./typescript-client.js"
import { CSharpLSPClient } from "./csharp-client.js"

export interface LSPServerManagerConfig {
	/** Use OmniSharp instead of csharp-ls for C# (default: false) */
	useOmniSharp?: boolean
	/** Custom path to typescript-language-server */
	typescriptServerPath?: string
	/** Custom path to C# language server */
	csharpServerPath?: string
}

/**
 * Manages LSP server lifecycle for multiple language servers
 * Handles lazy initialization, connection pooling, and graceful shutdown
 */
export class LSPServerManager {
	private clients: Map<string, ILSPClient> = new Map()
	private initPromises: Map<string, Promise<ILSPClient | null>> = new Map()
	private rootPaths: Map<string, string> = new Map()

	constructor(private readonly config: LSPServerManagerConfig = {}) {}

	/**
	 * Get or create an LSP client for a language
	 */
	async getClient(languageId: string, rootPath: string): Promise<ILSPClient | null> {
		// Check if we already have an initialized client
		const existingClient = this.clients.get(languageId)
		if (existingClient && existingClient.status === "ready") {
			const currentRoot = this.rootPaths.get(languageId)
			if (currentRoot === rootPath) {
				return existingClient
			}
			// Different root path - shutdown and reinitialize
			await existingClient.shutdown()
			this.clients.delete(languageId)
		}

		// Check if initialization is already in progress
		const existingPromise = this.initPromises.get(languageId)
		if (existingPromise) {
			return existingPromise
		}

		// Start initialization
		const initPromise = this._initializeClient(languageId, rootPath)
		this.initPromises.set(languageId, initPromise)

		try {
			const client = await initPromise
			return client
		} finally {
			this.initPromises.delete(languageId)
		}
	}

	/**
	 * Get client by file extension
	 */
	async getClientForFile(filePath: string, rootPath: string): Promise<ILSPClient | null> {
		const ext = path.extname(filePath).toLowerCase()
		const languageId = this.getLanguageIdForExtension(ext)

		if (!languageId) {
			return null
		}

		return this.getClient(languageId, rootPath)
	}

	/**
	 * Check if a language/extension is supported
	 */
	isLanguageSupported(extensionOrLanguageId: string): boolean {
		// Check if it's a language ID
		if (extensionOrLanguageId === "typescript" || extensionOrLanguageId === "csharp") {
			return true
		}

		// Check if it's an extension
		const ext = extensionOrLanguageId.startsWith(".")
			? extensionOrLanguageId.toLowerCase()
			: `.${extensionOrLanguageId.toLowerCase()}`

		return ext in EXTENSION_TO_LANGUAGE
	}

	/**
	 * Get status of all servers
	 */
	getStatuses(): Map<string, LSPServerStatus> {
		const statuses = new Map<string, LSPServerStatus>()

		for (const [languageId, client] of this.clients) {
			statuses.set(languageId, client.status)
		}

		// Also include pending initializations
		for (const languageId of this.initPromises.keys()) {
			if (!statuses.has(languageId)) {
				statuses.set(languageId, "starting")
			}
		}

		return statuses
	}

	/**
	 * Shutdown all servers
	 */
	async shutdownAll(): Promise<void> {
		const shutdownPromises: Promise<void>[] = []

		for (const client of this.clients.values()) {
			shutdownPromises.push(client.shutdown())
		}

		await Promise.all(shutdownPromises)
		this.clients.clear()
		this.rootPaths.clear()
	}

	/**
	 * Shutdown a specific server
	 */
	async shutdown(languageId: string): Promise<void> {
		const client = this.clients.get(languageId)
		if (client) {
			await client.shutdown()
			this.clients.delete(languageId)
			this.rootPaths.delete(languageId)
		}
	}

	/**
	 * Extension to language mapping
	 */
	private getLanguageIdForExtension(ext: string): string | null {
		return EXTENSION_TO_LANGUAGE[ext] || null
	}

	/**
	 * Initialize a client for a language
	 */
	private async _initializeClient(
		languageId: string,
		rootPath: string
	): Promise<ILSPClient | null> {
		try {
			let client: ILSPClient

			switch (languageId) {
				case "typescript":
					client = new TypeScriptLSPClient()
					break
				case "csharp":
					client = new CSharpLSPClient(this.config.useOmniSharp)
					break
				default:
					console.warn(`[LSPServerManager] Unsupported language: ${languageId}`)
					return null
			}

			await client.initialize(rootPath)
			this.clients.set(languageId, client)
			this.rootPaths.set(languageId, rootPath)

			console.log(`[LSPServerManager] ${languageId} server ready for ${rootPath}`)
			return client
		} catch (error) {
			console.error(
				`[LSPServerManager] Failed to initialize ${languageId}:`,
				error instanceof Error ? error.message : error
			)
			return null
		}
	}
}
