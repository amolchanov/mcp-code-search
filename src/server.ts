import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import express, { Request, Response } from "express"
import * as fs from "fs/promises"
import * as path from "path"
import { fileURLToPath } from "url"
import { spawn, ChildProcess } from "child_process"
import { SystemTray } from "./tray.js"
import { loadServerConfig, getFolderByPath, getAllFolders } from "./config/store.js"
import { queryLogger } from "./query-logger.js"
import { createEmbedder, getDefaultModelDimension } from "./embedders/index.js"
import { QdrantVectorStore } from "./vector-store/qdrant-client.js"
import { FolderManager } from "./folder-manager/folder-manager.js"
import { SearchService } from "./search/index.js"

// Tool imports
import {
	AddFolderSchema,
	RemoveFolderSchema,
	ListFoldersSchema,
	ClearIndexSchema,
	addFolder,
	removeFolder,
	listFolders,
	clearIndex,
} from "./tools/management.js"
import { SearchSchema, search } from "./tools/search.js"
import { GetStatusSchema, GetErrorsSchema, getStatus, getErrors } from "./tools/status.js"
import { ConfigureSchema, configure, getConfig } from "./tools/configure.js"

export class CodeSearchServer {
	private server: Server
	private folderManager: FolderManager | null = null
	private searchService: SearchService | null = null

	constructor() {
		this.server = new Server(
			{
				name: "code-search",
				version: "1.0.0",
			},
			{
				capabilities: {
					tools: {},
				},
			}
		)

		this.setupHandlers()
	}

	private setupHandlers(): void {
		// List available tools
		this.server.setRequestHandler(ListToolsRequestSchema, async () => {
			return {
				tools: [
					{
						name: "add_folder",
						description: "Add a folder to be indexed for semantic code search",
						inputSchema: {
							type: "object",
							properties: {
								path: {
									type: "string",
									description: "Absolute path to the folder to index",
								},
								startIndexing: {
									type: "boolean",
									description: "Whether to start indexing immediately (default: true)",
								},
							},
							required: ["path"],
						},
					},
					{
						name: "remove_folder",
						description: "Remove a folder from indexing and delete its index data",
						inputSchema: {
							type: "object",
							properties: {
								folderId: {
									type: "string",
									description: "ID of the folder to remove",
								},
								path: {
									type: "string",
									description: "Path of the folder to remove",
								},
							},
						},
					},
					{
						name: "list_folders",
						description: "List all indexed folders with their status",
						inputSchema: {
							type: "object",
							properties: {},
						},
					},
					{
						name: "clear_index",
						description: "Clear the index for a folder or all folders",
						inputSchema: {
							type: "object",
							properties: {
								folderId: {
									type: "string",
									description: "ID of the folder to clear",
								},
								path: {
									type: "string",
									description: "Path of the folder to clear",
								},
								all: {
									type: "boolean",
									description: "Clear all folder indexes (default: false)",
								},
							},
						},
					},
					{
						name: "search",
						description: "Perform semantic code search across indexed folders",
						inputSchema: {
							type: "object",
							properties: {
								query: {
									type: "string",
									description: "The search query for semantic code search",
								},
								folderId: {
									type: "string",
									description: "Filter results to a specific folder by ID",
								},
								folderPath: {
									type: "string",
									description: "Filter results to a specific folder by path",
								},
								fileTypes: {
									type: "array",
									items: { type: "string" },
									description: "Filter by file extensions (e.g., ['.ts', '.js'])",
								},
								pathPrefix: {
									type: "string",
									description: "Filter by path prefix within the folder",
								},
								minScore: {
									type: "number",
									description: "Minimum similarity score (0-1)",
								},
								maxResults: {
									type: "number",
									description: "Maximum number of results",
								},
							},
							required: ["query"],
						},
					},
					{
						name: "get_status",
						description: "Get indexing status for folders",
						inputSchema: {
							type: "object",
							properties: {
								folderId: {
									type: "string",
									description: "Get status for a specific folder",
								},
								detailed: {
									type: "boolean",
									description: "Include detailed progress information",
								},
							},
						},
					},
					{
						name: "get_errors",
						description: "Get error reports for indexing failures",
						inputSchema: {
							type: "object",
							properties: {
								folderId: {
									type: "string",
									description: "Filter errors by folder ID",
								},
								limit: {
									type: "number",
									description: "Maximum number of errors to return (default: 20)",
								},
								since: {
									type: "number",
									description: "Only return errors since this timestamp (ms)",
								},
							},
						},
					},
					{
						name: "configure",
						description: "Configure server settings (Qdrant connection, embedding provider, API keys)",
						inputSchema: {
							type: "object",
							properties: {
								qdrantUrl: { type: "string", description: "Qdrant server URL" },
								qdrantApiKey: { type: "string", description: "Qdrant API key" },
								embedderProvider: {
									type: "string",
									enum: ["openai", "ollama", "openai-compatible", "gemini", "mistral", "bedrock", "openrouter"],
									description: "Embedding provider to use",
								},
								modelId: { type: "string", description: "Model ID for embeddings" },
								modelDimension: { type: "number", description: "Embedding dimension" },
								openAiApiKey: { type: "string", description: "OpenAI API key" },
								ollamaBaseUrl: { type: "string", description: "Ollama base URL" },
								openAiCompatibleBaseUrl: { type: "string", description: "OpenAI-compatible API base URL" },
								openAiCompatibleApiKey: { type: "string", description: "OpenAI-compatible API key" },
								geminiApiKey: { type: "string", description: "Google Gemini API key" },
								mistralApiKey: { type: "string", description: "Mistral API key" },
								bedrockRegion: { type: "string", description: "AWS Bedrock region" },
								bedrockProfile: { type: "string", description: "AWS profile name" },
								openRouterApiKey: { type: "string", description: "OpenRouter API key" },
								openRouterSpecificProvider: { type: "string", description: "OpenRouter specific provider" },
								searchMinScore: { type: "number", description: "Minimum search score threshold" },
								searchMaxResults: { type: "number", description: "Maximum search results" },
								batchSize: { type: "number", description: "Embedding batch size" },
							},
						},
					},
				],
			}
		})

		// Handle tool calls
		this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const { name, arguments: args } = request.params

			try {
				let result: string

				switch (name) {
					case "add_folder": {
						if (!this.folderManager) {
							result = JSON.stringify({ success: false, error: "Server not initialized" })
						} else {
							const parsed = AddFolderSchema.parse(args)
							result = await addFolder(this.folderManager, parsed)
						}
						break
					}

					case "remove_folder": {
						if (!this.folderManager) {
							result = JSON.stringify({ success: false, error: "Server not initialized" })
						} else {
							const parsed = RemoveFolderSchema.parse(args)
							result = await removeFolder(this.folderManager, parsed)
						}
						break
					}

					case "list_folders": {
						if (!this.folderManager) {
							result = JSON.stringify({ success: false, error: "Server not initialized" })
						} else {
							result = await listFolders(this.folderManager)
						}
						break
					}

					case "clear_index": {
						if (!this.folderManager) {
							result = JSON.stringify({ success: false, error: "Server not initialized" })
						} else {
							const parsed = ClearIndexSchema.parse(args)
							result = await clearIndex(this.folderManager, parsed)
						}
						break
					}

					case "search": {
						if (!this.searchService) {
							result = JSON.stringify({ success: false, error: "Server not initialized" })
						} else {
							const parsed = SearchSchema.parse(args)
							result = await search(this.searchService, parsed)
						}
						break
					}

					case "get_status": {
						if (!this.folderManager) {
							result = JSON.stringify({ success: false, error: "Server not initialized" })
						} else {
							const parsed = GetStatusSchema.parse(args)
							result = await getStatus(this.folderManager, parsed)
						}
						break
					}

					case "get_errors": {
						if (!this.folderManager) {
							result = JSON.stringify({ success: false, error: "Server not initialized" })
						} else {
							const parsed = GetErrorsSchema.parse(args)
							result = await getErrors(this.folderManager, parsed)
						}
						break
					}

					case "configure": {
						const parsed = ConfigureSchema.parse(args)
						result = await configure(parsed)
						break
					}

					default:
						result = JSON.stringify({ success: false, error: `Unknown tool: ${name}` })
				}

				return {
					content: [{ type: "text", text: result }],
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
					isError: true,
				}
			}
		})
	}

	async initialize(): Promise<void> {
		console.error("[CodeSearch] Initializing server...")

		try {
			// Load configuration
			const config = await loadServerConfig()
			console.error(`[CodeSearch] Using embedder: ${config.embedderProvider}`)
			console.error(`[CodeSearch] Qdrant URL: ${config.qdrantUrl}`)

			// Create embedder
			const embedder = createEmbedder(config)

			// Validate embedder configuration (warn but don't fail)
			const validation = await embedder.validateConfiguration()
			if (!validation.valid) {
				console.error(`[CodeSearch] WARNING: Embedder validation failed: ${validation.error}`)
				console.error("[CodeSearch] Server will start, but you need to configure a working embedder using the 'configure' tool")
			} else {
				console.error("[CodeSearch] Embedder validated successfully")
			}

			// Get vector dimension
			const vectorDimension = config.modelDimension || getDefaultModelDimension(config.embedderProvider, config.modelId)
			console.error(`[CodeSearch] Vector dimension: ${vectorDimension}`)

			// Create vector store
			const vectorStore = new QdrantVectorStore(config.qdrantUrl, vectorDimension, config.qdrantApiKey)
			try {
				await vectorStore.initialize()
				console.error("[CodeSearch] Vector store initialized")
			} catch (error) {
				console.error(`[CodeSearch] WARNING: Vector store initialization failed: ${error instanceof Error ? error.message : error}`)
				console.error("[CodeSearch] Server will start, but you need a running Qdrant instance and may need to reconfigure using the 'configure' tool")
			}

			// Create folder manager
			const wasmDir = path.join(process.cwd(), "wasm")
			this.folderManager = new FolderManager(embedder, vectorStore, wasmDir, {
				onStatusChange: (folderId, status) => {
					console.error(`[CodeSearch] Folder ${folderId} status: ${status}`)
				},
				onError: (error) => {
					console.error(`[CodeSearch] Error: ${error.error}`)
				},
			})
			try {
				await this.folderManager.initialize()
				console.error("[CodeSearch] Folder manager initialized")
			} catch (error) {
				console.error(`[CodeSearch] WARNING: Folder manager initialization failed: ${error instanceof Error ? error.message : error}`)
			}

			// Create search service
			this.searchService = new SearchService(embedder, vectorStore)

			// Resume indexing for existing folders
			try {
				await this.folderManager.resumeIndexing()
				console.error("[CodeSearch] Resumed indexing for existing folders")
			} catch (error) {
				console.error(`[CodeSearch] WARNING: Could not resume indexing: ${error instanceof Error ? error.message : error}`)
			}

			console.error("[CodeSearch] Server initialized successfully")
		} catch (error) {
			console.error("[CodeSearch] Initialization failed:", error)
			throw error
		}
	}

	async run(mode: "stdio" | "sse" = "stdio", port: number = 3100, useTray: boolean = false, autoIndexPaths: string[] = []): Promise<void> {
		await this.initialize()

		// Auto-index specified folders
		if (autoIndexPaths.length > 0 && this.folderManager) {
			for (const folderPath of autoIndexPaths) {
				try {
					const existing = await getFolderByPath(folderPath)
					if (existing) {
						console.error(`[CodeSearch] Folder already indexed: ${folderPath}`)
					} else {
						console.error(`[CodeSearch] Auto-indexing folder: ${folderPath}`)
						await this.folderManager.addFolder(folderPath, true)
					}
				} catch (error) {
					console.error(`[CodeSearch] Failed to auto-index ${folderPath}: ${error instanceof Error ? error.message : error}`)
				}
			}
		}

		if (mode === "sse") {
			await this.runSSE(port, useTray)
		} else {
			const transport = new StdioServerTransport()
			await this.server.connect(transport)
			console.error("[CodeSearch] Server running on stdio")
		}
	}

	private async runSSE(port: number, useTray: boolean): Promise<void> {
		const app = express()
		let transport: SSEServerTransport | null = null
		let tray: SystemTray | null = null

		// Default limits - can be overridden via query params
		const DEFAULT_QUERIES_LIMIT = 100
		const DEFAULT_INGESTION_LIMIT = 100

		const shutdown = async () => {
			console.error("[CodeSearch] Shutting down...")
			if (tray) await tray.stop()
			await this.shutdown()
			process.exit(0)
		}

		app.get("/sse", (req: Request, res: Response) => {
			console.error("[CodeSearch] SSE connection established")
			transport = new SSEServerTransport("/messages", res)
			this.server.connect(transport)
		})

		app.post("/messages", (req: Request, res: Response) => {
			if (!transport) {
				res.status(400).send("No SSE connection established")
				return
			}
			transport.handlePostMessage(req, res)
		})

		app.get("/health", (_req: Request, res: Response) => {
			res.json({ status: "ok" })
		})

		app.post("/shutdown", async (_req: Request, res: Response) => {
			res.json({ status: "shutting down" })
			await shutdown()
		})

		// Admin UI - serve static HTML
		app.get("/admin", async (_req: Request, res: Response) => {
			try {
				const __filename = fileURLToPath(import.meta.url)
				const __dirname = path.dirname(__filename)
				const htmlPath = path.join(__dirname, "admin", "index.html")
				const html = await fs.readFile(htmlPath, "utf-8")
				res.setHeader("Content-Type", "text/html")
				res.send(html)
			} catch (error) {
				res.status(500).send("Admin UI not found")
			}
		})

		// Admin API - Get queries per folder
		app.get("/api/admin/queries", async (req: Request, res: Response) => {
			try {
				const limit = parseInt(req.query.limit as string) || DEFAULT_QUERIES_LIMIT

				const folders = await getAllFolders()
				const queriesByFolder = await queryLogger.getQueriesByFolder()

				// Build response with folder info
				const folderQueries = folders.map((folder) => {
					const queries = queriesByFolder.get(folder.id) || []
					return {
						id: folder.id,
						name: folder.name,
						path: folder.path,
						queries: queries.slice(0, limit),
					}
				})

				// Get global queries (those without a folder filter)
				const globalQueries = (queriesByFolder.get(null) || []).slice(0, limit)

				res.json({
					folders: folderQueries,
					globalQueries,
				})
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Get ingestion progress per folder
		app.get("/api/admin/ingestion", async (req: Request, res: Response) => {
			try {
				const folders = await getAllFolders()

				if (!this.folderManager) {
					res.json({ folders: [] })
					return
				}

				const allStatuses = this.folderManager.getAllStatuses()

				const folderProgress = folders.map((folder) => {
					const statusInfo = allStatuses.get(folder.id)
					return {
						id: folder.id,
						name: folder.name,
						path: folder.path,
						status: statusInfo?.status || folder.status,
						fileCount: folder.fileCount,
						errorCount: folder.errorCount,
						lastError: folder.lastError,
						addedAt: folder.addedAt,
						lastIndexedAt: folder.lastIndexedAt,
						progress: statusInfo?.progress || {
							folderId: folder.id,
							status: folder.status,
							processedFiles: 0,
							totalFiles: folder.fileCount || 0,
							indexedBlocks: 0,
						},
					}
				})

				res.json({ folders: folderProgress })
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Get errors for a folder
		app.get("/api/admin/errors", async (req: Request, res: Response) => {
			try {
				const folderId = req.query.folderId as string | undefined
				const limit = parseInt(req.query.limit as string) || DEFAULT_INGESTION_LIMIT

				if (!this.folderManager) {
					res.json({ errors: [] })
					return
				}

				const errors = this.folderManager.getErrors(folderId, limit)
				res.json({ errors })
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Clear query logs
		app.delete("/api/admin/queries", async (req: Request, res: Response) => {
			try {
				const folderId = req.query.folderId as string | undefined
				await queryLogger.clearQueries(folderId)
				res.json({ success: true })
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Ollama process management
		let ollamaProcess: ChildProcess | null = null

		const checkOllamaStatus = async (): Promise<{ running: boolean; models: string[]; error?: string }> => {
			try {
				const config = await loadServerConfig()
				const baseUrl = config.ollamaBaseUrl || "http://localhost:11434"
				const controller = new AbortController()
				const timeoutId = setTimeout(() => controller.abort(), 5000)

				const response = await fetch(`${baseUrl}/api/tags`, {
					method: "GET",
					signal: controller.signal,
				})
				clearTimeout(timeoutId)

				if (response.ok) {
					const data = (await response.json()) as { models?: Array<{ name?: string }> }
					const models = (data.models || []).map((m) => m.name || "").filter(Boolean)
					return { running: true, models }
				}
				return { running: false, models: [], error: `HTTP ${response.status}` }
			} catch (error) {
				return { running: false, models: [], error: error instanceof Error ? error.message : "Unknown error" }
			}
		}

		const startOllama = async (): Promise<{ success: boolean; error?: string }> => {
			if (ollamaProcess) {
				return { success: false, error: "Ollama process already managed by this server" }
			}

			// Check if already running
			const status = await checkOllamaStatus()
			if (status.running) {
				return { success: true }
			}

			return new Promise((resolve) => {
				try {
					console.error("[CodeSearch] Starting Ollama...")
					const isWindows = process.platform === "win32"
					const command = isWindows ? "ollama.exe" : "ollama"

					ollamaProcess = spawn(command, ["serve"], {
						detached: !isWindows,
						stdio: "ignore",
						shell: isWindows,
					})

					ollamaProcess.on("error", (err) => {
						console.error("[CodeSearch] Failed to start Ollama:", err.message)
						ollamaProcess = null
						resolve({ success: false, error: err.message })
					})

					ollamaProcess.on("exit", (code) => {
						console.error(`[CodeSearch] Ollama process exited with code ${code}`)
						ollamaProcess = null
					})

					// Wait for Ollama to be ready
					let attempts = 0
					const maxAttempts = 30
					const checkInterval = setInterval(async () => {
						attempts++
						const status = await checkOllamaStatus()
						if (status.running) {
							clearInterval(checkInterval)
							console.error("[CodeSearch] Ollama started successfully")
							resolve({ success: true })
						} else if (attempts >= maxAttempts) {
							clearInterval(checkInterval)
							resolve({ success: false, error: "Ollama failed to start within timeout" })
						}
					}, 1000)
				} catch (error) {
					resolve({ success: false, error: error instanceof Error ? error.message : "Unknown error" })
				}
			})
		}

		const stopOllama = async (): Promise<{ success: boolean; error?: string }> => {
			if (ollamaProcess) {
				try {
					ollamaProcess.kill()
					ollamaProcess = null
					return { success: true }
				} catch (error) {
					return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
				}
			}
			return { success: false, error: "No Ollama process managed by this server" }
		}

		// Admin API - Get Ollama status
		app.get("/api/admin/ollama/status", async (_req: Request, res: Response) => {
			try {
				const config = await loadServerConfig()
				const status = await checkOllamaStatus()
				res.json({
					...status,
					baseUrl: config.ollamaBaseUrl || "http://localhost:11434",
					configuredModel: config.modelId || "nomic-embed-text:latest",
					managedByServer: ollamaProcess !== null,
				})
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Start Ollama
		app.post("/api/admin/ollama/start", async (_req: Request, res: Response) => {
			try {
				const result = await startOllama()
				res.json(result)
			} catch (error) {
				res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Stop Ollama
		app.post("/api/admin/ollama/stop", async (_req: Request, res: Response) => {
			try {
				const result = await stopOllama()
				res.json(result)
			} catch (error) {
				res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Auto-start Ollama on server startup
		const config = await loadServerConfig()
		if (config.embedderProvider === "ollama") {
			const status = await checkOllamaStatus()
			if (!status.running) {
				console.error("[CodeSearch] Ollama not running, attempting to start...")
				const result = await startOllama()
				if (!result.success) {
					console.error(`[CodeSearch] Failed to auto-start Ollama: ${result.error}`)
				}
			}
		}

		app.listen(port, () => {
			console.error(`[CodeSearch] Server running on http://localhost:${port}`)
			console.error(`[CodeSearch] SSE endpoint: http://localhost:${port}/sse`)
			console.error(`[CodeSearch] Admin UI: http://localhost:${port}/admin`)

			if (useTray) {
				tray = new SystemTray(port, { onStop: shutdown })
				tray.start()
				console.error("[CodeSearch] System tray icon active")
			}
		})
	}

	async shutdown(): Promise<void> {
		if (this.folderManager) {
			await this.folderManager.dispose()
		}
		await this.server.close()
	}
}
