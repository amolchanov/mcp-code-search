import { spawn, ChildProcess } from "child_process"
import {
	createMessageConnection,
	MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node.js"
import {
	InitializeParams,
	InitializeResult,
	TextDocumentIdentifier,
	Position,
	Hover,
	MarkupContent,
} from "vscode-languageserver-protocol"
import * as path from "path"
import { pathToFileURL } from "url"
import type { ILSPClient, LSPServerStatus } from "./types.js"

// LSP method names as strings (to avoid type compatibility issues)
const LSP_METHODS = {
	INITIALIZE: "initialize",
	INITIALIZED: "initialized",
	SHUTDOWN: "shutdown",
	EXIT: "exit",
	TEXT_DOCUMENT_DID_OPEN: "textDocument/didOpen",
	TEXT_DOCUMENT_DID_CLOSE: "textDocument/didClose",
	TEXT_DOCUMENT_HOVER: "textDocument/hover",
} as const

/**
 * Abstract base class for LSP clients
 * Handles common LSP protocol operations
 */
export abstract class LSPClientBase implements ILSPClient {
	protected connection: MessageConnection | null = null
	protected process: ChildProcess | null = null
	protected _status: LSPServerStatus = "stopped"
	protected rootPath: string = ""
	protected openDocuments: Set<string> = new Set()
	private initPromise: Promise<void> | null = null

	abstract readonly languageId: string
	abstract getServerCommand(): { command: string; args: string[] }
	abstract getLanguageId(filePath: string): string

	get status(): LSPServerStatus {
		return this._status
	}

	/**
	 * Initialize the LSP server
	 */
	async initialize(rootPath: string): Promise<void> {
		// If already initializing, wait for it
		if (this.initPromise) {
			return this.initPromise
		}

		// If already ready, just update root if needed
		if (this._status === "ready" && this.rootPath === rootPath) {
			return
		}

		this.initPromise = this._doInitialize(rootPath)
		try {
			await this.initPromise
		} finally {
			this.initPromise = null
		}
	}

	private async _doInitialize(rootPath: string): Promise<void> {
		this._status = "starting"
		this.rootPath = rootPath

		try {
			// Spawn the language server process
			const { command, args } = this.getServerCommand()

			this.process = spawn(command, args, {
				stdio: ["pipe", "pipe", "pipe"],
				shell: process.platform === "win32", // Required on Windows for npm globals
				cwd: rootPath,
			})

			if (!this.process.stdout || !this.process.stdin) {
				throw new Error("Failed to create process streams")
			}

			// Create message connection
			const reader = new StreamMessageReader(this.process.stdout)
			const writer = new StreamMessageWriter(this.process.stdin)
			this.connection = createMessageConnection(reader, writer)

			// Handle process errors
			this.process.on("error", (err) => {
				console.error(`[LSP:${this.languageId}] Process error:`, err.message)
				this._status = "error"
			})

			this.process.on("exit", (code) => {
				console.log(`[LSP:${this.languageId}] Process exited with code ${code}`)
				this._status = "stopped"
				this.connection = null
				this.process = null
			})

			this.process.stderr?.on("data", (data) => {
				// Log stderr but don't treat as error (many LSP servers log here)
				const msg = data.toString().trim()
				if (msg) {
					console.log(`[LSP:${this.languageId}] ${msg}`)
				}
			})

			// Start listening
			this.connection.listen()

			// Send initialize request
			const initParams: InitializeParams = {
				processId: process.pid,
				rootUri: pathToFileURL(rootPath).toString(),
				capabilities: {
					textDocument: {
						hover: {
							contentFormat: ["markdown", "plaintext"],
						},
						synchronization: {
							dynamicRegistration: false,
							willSave: false,
							willSaveWaitUntil: false,
							didSave: false,
						},
					},
					workspace: {
						workspaceFolders: true,
					},
				},
				workspaceFolders: [
					{
						uri: pathToFileURL(rootPath).toString(),
						name: path.basename(rootPath),
					},
				],
			}

			const initResult = await this.connection.sendRequest<InitializeResult>(
				LSP_METHODS.INITIALIZE,
				initParams
			)
			console.log(`[LSP:${this.languageId}] Initialized:`, initResult.serverInfo?.name || "unknown")

			// Send initialized notification
			await this.connection.sendNotification(LSP_METHODS.INITIALIZED, {})

			this._status = "ready"
		} catch (error) {
			console.error(`[LSP:${this.languageId}] Initialization failed:`, error)
			this._status = "error"
			await this.shutdown()
			throw error
		}
	}

	/**
	 * Get hover information at a position
	 */
	async getHoverInfo(
		filePath: string,
		line: number,
		character: number
	): Promise<{ typeSignature?: string; documentation?: string } | null> {
		if (!this.connection || this._status !== "ready") {
			return null
		}

		try {
			const uri = pathToFileURL(filePath).toString()
			const params = {
				textDocument: TextDocumentIdentifier.create(uri),
				position: Position.create(line, character),
			}

			const hover = await this.connection.sendRequest<Hover | null>(
				LSP_METHODS.TEXT_DOCUMENT_HOVER,
				params
			)
			return this.parseHoverContent(hover)
		} catch (error) {
			// Hover failures are common and not critical
			return null
		}
	}

	/**
	 * Notify server that a document was opened
	 */
	async openDocument(filePath: string, content: string): Promise<void> {
		if (!this.connection || this._status !== "ready") {
			return
		}

		const uri = pathToFileURL(filePath).toString()

		// Don't re-open already opened documents
		if (this.openDocuments.has(uri)) {
			return
		}

		try {
			await this.connection.sendNotification(LSP_METHODS.TEXT_DOCUMENT_DID_OPEN, {
				textDocument: {
					uri,
					languageId: this.getLanguageId(filePath),
					version: 1,
					text: content,
				},
			})
			this.openDocuments.add(uri)
		} catch (error) {
			// Non-critical
		}
	}

	/**
	 * Notify server that a document was closed
	 */
	async closeDocument(filePath: string): Promise<void> {
		if (!this.connection || this._status !== "ready") {
			return
		}

		const uri = pathToFileURL(filePath).toString()

		if (!this.openDocuments.has(uri)) {
			return
		}

		try {
			await this.connection.sendNotification(LSP_METHODS.TEXT_DOCUMENT_DID_CLOSE, {
				textDocument: { uri },
			})
			this.openDocuments.delete(uri)
		} catch (error) {
			// Non-critical
		}
	}

	/**
	 * Shutdown the LSP server
	 */
	async shutdown(): Promise<void> {
		if (this.connection && this._status === "ready") {
			try {
				// Close all open documents
				for (const uri of this.openDocuments) {
					await this.connection.sendNotification(LSP_METHODS.TEXT_DOCUMENT_DID_CLOSE, {
						textDocument: { uri },
					})
				}
				this.openDocuments.clear()

				// Send shutdown request
				await this.connection.sendRequest(LSP_METHODS.SHUTDOWN)
				// Send exit notification
				await this.connection.sendNotification(LSP_METHODS.EXIT)
			} catch (error) {
				// Ignore errors during shutdown
			}
		}

		// Dispose connection
		if (this.connection) {
			this.connection.dispose()
			this.connection = null
		}

		// Kill process if still running
		if (this.process) {
			this.process.kill()
			this.process = null
		}

		this._status = "stopped"
	}

	/**
	 * Parse hover content into type signature and documentation
	 */
	protected parseHoverContent(
		hover: Hover | null
	): { typeSignature?: string; documentation?: string } | null {
		if (!hover || !hover.contents) {
			return null
		}

		let typeSignature: string | undefined
		let documentation: string | undefined

		const contents = hover.contents

		if (typeof contents === "string") {
			// Plain string
			const parsed = this.extractTypeAndDocs(contents)
			typeSignature = parsed.typeSignature
			documentation = parsed.documentation
		} else if (MarkupContent.is(contents)) {
			// MarkupContent (markdown or plaintext)
			const parsed = this.extractTypeAndDocs(contents.value)
			typeSignature = parsed.typeSignature
			documentation = parsed.documentation
		} else if (Array.isArray(contents)) {
			// Array of MarkedString
			for (const item of contents) {
				if (typeof item === "string") {
					const parsed = this.extractTypeAndDocs(item)
					if (!typeSignature && parsed.typeSignature) typeSignature = parsed.typeSignature
					if (!documentation && parsed.documentation) documentation = parsed.documentation
				} else if ("value" in item) {
					const parsed = this.extractTypeAndDocs(item.value)
					if (!typeSignature && parsed.typeSignature) typeSignature = parsed.typeSignature
					if (!documentation && parsed.documentation) documentation = parsed.documentation
				}
			}
		} else if ("value" in contents) {
			// MarkedString with language
			const parsed = this.extractTypeAndDocs(contents.value)
			typeSignature = parsed.typeSignature
			documentation = parsed.documentation
		}

		if (!typeSignature && !documentation) {
			return null
		}

		return { typeSignature, documentation }
	}

	/**
	 * Extract type signature and documentation from hover text
	 * Override in subclasses for language-specific parsing
	 */
	protected extractTypeAndDocs(text: string): {
		typeSignature?: string
		documentation?: string
	} {
		// Default implementation: look for code blocks
		const codeBlockMatch = text.match(/```[\w]*\n?([\s\S]*?)```/)
		const typeSignature = codeBlockMatch ? codeBlockMatch[1].trim() : undefined

		// Documentation is everything outside code blocks
		let documentation: string | undefined = text.replace(/```[\w]*\n?[\s\S]*?```/g, "").trim()
		if (!documentation) documentation = undefined

		return { typeSignature, documentation }
	}
}
