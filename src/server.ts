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
import { loadServerConfig, saveServerConfig, getFolderByPath, getAllFolders, updateFolder } from "./config/store.js"
import { queryLogger } from "./query-logger.js"
import { createEmbedder, getDefaultModelDimension } from "./embedders/index.js"
import { QdrantVectorStore } from "./vector-store/qdrant-client.js"
import { FolderManager } from "./folder-manager/folder-manager.js"
import { SearchService } from "./search/index.js"
import type { IVectorStore } from "./types/index.js"

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
	private httpServer: any = null

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

	private async resolveFolderId(folderId?: string, folderPath?: string): Promise<string | null> {
		if (folderId) return folderId
		if (folderPath) {
			const folder = await getFolderByPath(folderPath)
			return folder?.id || null
		}
		return null
	}

	private getInstructionsContent(format: string): string {
		const claudeInstructions = `# Code Search Instructions

## Code Search Strategy

**IMPORTANT:** Always prefer the \`mcp__code-search__search\` tool over built-in \`Grep\` and \`Glob\` tools for finding code.

### When to use \`mcp__code-search__search\` (DEFAULT)
- Finding where functionality is implemented ("where do we handle authentication")
- Understanding code flow ("how does the session manager work")
- Locating related code ("find all error handling logic")
- Exploring unfamiliar parts of the codebase
- Any natural language query about the code

### When to use \`Grep\` (FALLBACK ONLY)
- \`mcp__code-search__search\` returns no results or service is unavailable
- Searching for exact strings, symbols, or regex patterns (e.g., \`className\`, \`TODO:\`)
- Finding specific identifiers or variable names

### When to use \`Glob\`
- Finding files by name pattern (e.g., \`**/*.cs\`, \`**/test_*.py\`)
- Listing files in a directory structure

### Search workflow
1. **First:** Try \`mcp__code-search__search\` with a descriptive natural language query
2. **If no results:** Fall back to \`Grep\` with specific patterns
3. **For file discovery:** Use \`Glob\` for pattern-based file finding

## Available MCP Tools

- \`mcp__code-search__search\` - Semantic code search
  - query: Natural language description of what you're looking for
  - folderPath: (optional) Limit search to a specific folder
  - maxResults: (optional) Number of results (default: 10)

- \`mcp__code-search__add_folder\` - Index a new folder for searching
- \`mcp__code-search__list_folders\` - See all indexed folders and their status
- \`mcp__code-search__get_status\` - Check indexing progress
- \`mcp__code-search__reindex_folder\` - Reindex a folder
- \`mcp__code-search__pause_indexing\` - Pause indexing
- \`mcp__code-search__resume_indexing\` - Resume indexing

## Example Queries

Good semantic queries:
- "authentication middleware that validates JWT tokens"
- "database connection pooling implementation"
- "error handling for API requests"
- "React component that renders a data table"
- "method that handles user login in AuthController"
- "function that validates email addresses"

## Tips

- Be descriptive: "user authentication" works better than "auth"
- Include context: "validation method in UserService" helps narrow results
- Search before implementing: find existing patterns to follow
`

		const copilotInstructions = `# Code Search Instructions for Copilot

## Semantic Code Search

Use the code-search MCP server for finding code by meaning, not just keywords.

### Search Tool
\`code-search.search\` - Semantic code search
- query: Natural language description
- folderPath: (optional) Filter by folder
- maxResults: (optional) Limit results

### Example Queries
- "authentication middleware that validates JWT tokens"
- "database connection pooling implementation"
- "error handling for API requests"

### Tips
- Use descriptive natural language queries
- Search before implementing to find existing patterns
- Fall back to grep only for exact string matches
`

		const genericInstructions = `# Code Search MCP Server Instructions

## Overview
The code-search MCP server provides semantic code search using vector embeddings.

## Tools
- \`search\` - Semantic code search with natural language queries
- \`add_folder\` - Add a folder to be indexed
- \`list_folders\` - List indexed folders
- \`get_status\` - Check indexing progress
- \`reindex_folder\` - Reindex a folder
- \`pause_indexing\` / \`resume_indexing\` - Control indexing

## Usage
1. Add folders to index: \`add_folder\` with the folder path
2. Wait for indexing to complete: check \`get_status\`
3. Search with natural language: \`search\` with your query

## Example Queries
- "function that handles user authentication"
- "database connection setup"
- "API error handling middleware"
`

		switch (format) {
			case "copilot":
				return copilotInstructions
			case "generic":
				return genericInstructions
			case "claude":
			default:
				return claudeInstructions
		}
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
					{
						name: "reindex_folder",
						description: "Reindex a folder (clears existing index and re-indexes all files)",
						inputSchema: {
							type: "object",
							properties: {
								folderId: { type: "string", description: "ID of the folder to reindex" },
								path: { type: "string", description: "Path of the folder to reindex" },
							},
						},
					},
					{
						name: "pause_indexing",
						description: "Pause indexing for a folder",
						inputSchema: {
							type: "object",
							properties: {
								folderId: { type: "string", description: "ID of the folder to pause" },
								path: { type: "string", description: "Path of the folder to pause" },
							},
						},
					},
					{
						name: "resume_indexing",
						description: "Resume paused indexing for a folder",
						inputSchema: {
							type: "object",
							properties: {
								folderId: { type: "string", description: "ID of the folder to resume" },
								path: { type: "string", description: "Path of the folder to resume" },
							},
						},
					},
					{
						name: "reenrich_folder",
						description: "Re-enrich a folder with LSP data without clearing the index",
						inputSchema: {
							type: "object",
							properties: {
								folderId: { type: "string", description: "ID of the folder to re-enrich" },
								path: { type: "string", description: "Path of the folder to re-enrich" },
							},
						},
					},
					{
						name: "get_instructions",
						description: "Get instructions for configuring AI assistants (Claude, Copilot) to use code-search effectively. Returns markdown content suitable for CLAUDE.md or similar agent instruction files.",
						inputSchema: {
							type: "object",
							properties: {
								format: {
									type: "string",
									enum: ["claude", "copilot", "generic"],
									description: "Format of instructions to return (default: claude)",
								},
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

					case "reindex_folder": {
						if (!this.folderManager) {
							result = JSON.stringify({ success: false, error: "Server not initialized" })
							break
						}
						const folderId = await this.resolveFolderId(args?.folderId as string, args?.path as string)
						if (!folderId) {
							result = JSON.stringify({ success: false, error: "Folder not found. Provide folderId or path." })
							break
						}
						await this.folderManager.reindex(folderId)
						result = JSON.stringify({ success: true, message: "Reindexing started" })
						break
					}

					case "pause_indexing": {
						if (!this.folderManager) {
							result = JSON.stringify({ success: false, error: "Server not initialized" })
							break
						}
						const folderId = await this.resolveFolderId(args?.folderId as string, args?.path as string)
						if (!folderId) {
							result = JSON.stringify({ success: false, error: "Folder not found. Provide folderId or path." })
							break
						}
						this.folderManager.pauseIndexing(folderId)
						result = JSON.stringify({ success: true, message: "Indexing paused" })
						break
					}

					case "resume_indexing": {
						if (!this.folderManager) {
							result = JSON.stringify({ success: false, error: "Server not initialized" })
							break
						}
						const folderId = await this.resolveFolderId(args?.folderId as string, args?.path as string)
						if (!folderId) {
							result = JSON.stringify({ success: false, error: "Folder not found. Provide folderId or path." })
							break
						}
						this.folderManager.resumeFolderIndexing(folderId)
						result = JSON.stringify({ success: true, message: "Indexing resumed" })
						break
					}

					case "reenrich_folder": {
						if (!this.folderManager) {
							result = JSON.stringify({ success: false, error: "Server not initialized" })
							break
						}
						const folderId = await this.resolveFolderId(args?.folderId as string, args?.path as string)
						if (!folderId) {
							result = JSON.stringify({ success: false, error: "Folder not found. Provide folderId or path." })
							break
						}
						await this.folderManager.reEnrich(folderId)
						result = JSON.stringify({ success: true, message: "Re-enrichment started" })
						break
					}

					case "get_instructions": {
						const format = (args?.format as string) || "claude"
						result = this.getInstructionsContent(format)
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
			// Use modelId for embedding cache key (includes provider for uniqueness)
			const embeddingCacheModelId = config.modelId
				? `${config.embedderProvider}:${config.modelId}`
				: config.embedderProvider

			// Configure LSP options
			const lspOptions = config.lspEnabled
				? {
						enabled: true,
						timeout: config.lspTimeout,
						maxConcurrentRequests: config.lspMaxConcurrentRequests,
						useOmniSharp: config.lspUseOmniSharp,
				  }
				: undefined

			if (lspOptions) {
				console.error("[CodeSearch] LSP enrichment enabled")
			}

			this.folderManager = new FolderManager(embedder, vectorStore, wasmDir, {
				onStatusChange: (folderId, status) => {
					console.error(`[CodeSearch] Folder ${folderId} status: ${status}`)
				},
				onError: (error) => {
					console.error(`[CodeSearch] Error: ${error.error}`)
				},
			}, { pollInterval: config.fileWatcherPollInterval }, embeddingCacheModelId, lspOptions, {
				parsingConcurrency: config.parsingConcurrency,
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

			// Auto-warm embedding cache in background if needed
			this.autoWarmCache(vectorStore).catch((error) => {
				console.error(`[CodeSearch] Cache warming failed: ${error instanceof Error ? error.message : error}`)
			})

			console.error("[CodeSearch] Server initialized successfully")
		} catch (error) {
			console.error("[CodeSearch] Initialization failed:", error)
			throw error
		}
	}

	async run(mode: "stdio" | "sse" = "stdio", port: number = 3100, useTray: boolean = false, autoIndexPaths: string[] = []): Promise<void> {
		await this.initialize()

		// Clean up old query logs on startup
		try {
			const deletedCount = await queryLogger.cleanupOldLogs()
			if (deletedCount > 0) {
				console.error(`[CodeSearch] Cleaned up ${deletedCount} old query log file(s)`)
			}
		} catch (error) {
			console.error(`[CodeSearch] Warning: Failed to cleanup query logs: ${error instanceof Error ? error.message : error}`)
		}

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
		app.use(express.json()) // Parse JSON request bodies
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

		// Admin API - Get query log stats
		app.get("/api/admin/queries/stats", async (_req: Request, res: Response) => {
			try {
				const stats = await queryLogger.getLogStats()
				res.json(stats)
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Cleanup old query logs
		app.post("/api/admin/queries/cleanup", async (req: Request, res: Response) => {
			try {
				const retentionDays = parseInt(req.query.retentionDays as string) || 7
				const deletedCount = await queryLogger.cleanupOldLogs(retentionDays)
				res.json({ success: true, deletedCount })
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Browse directories (for folder picker)
		app.get("/api/admin/browse", async (req: Request, res: Response) => {
			try {
				const dirPath = (req.query.path as string) || (process.platform === "win32" ? "C:\\" : "/")
				const fs = await import("fs/promises")
				const path = await import("path")

				const stats = await fs.stat(dirPath)
				if (!stats.isDirectory()) {
					res.status(400).json({ error: "Not a directory" })
					return
				}

				const entries = await fs.readdir(dirPath, { withFileTypes: true })
				const directories = entries
					.filter((e) => e.isDirectory() && !e.name.startsWith("."))
					.map((e) => ({
						name: e.name,
						path: path.join(dirPath, e.name),
					}))
					.sort((a, b) => a.name.localeCompare(b.name))

				// Get parent directory
				const parent = path.dirname(dirPath)
				const hasParent = parent !== dirPath

				res.json({
					current: dirPath,
					parent: hasParent ? parent : null,
					directories,
				})
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - List all folders
		app.get("/api/admin/folders", async (_req: Request, res: Response) => {
			try {
				const folders = await getAllFolders()
				if (!this.folderManager) {
					res.json({ folders })
					return
				}

				const allStatuses = this.folderManager.getAllStatuses()

				// Get file counts from cache managers
				const foldersWithStatus = folders.map((folder) => {
					const statusInfo = allStatuses.get(folder.id)
					const fileCount = this.folderManager!.getFileCount(folder.id) || folder.fileCount || 0

					return {
						...folder,
						status: statusInfo?.status || folder.status,
						progress: statusInfo?.progress,
						fileCount,
					}
				})

				res.json({ folders: foldersWithStatus })
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Add a folder
		app.post("/api/admin/folders", async (req: Request, res: Response) => {
			try {
				const { path: folderPath } = req.body
				if (!folderPath) {
					res.status(400).json({ success: false, error: "Path is required" })
					return
				}

				if (!this.folderManager) {
					res.status(500).json({ success: false, error: "Server not initialized" })
					return
				}

				const folder = await this.folderManager.addFolder(folderPath, true)
				res.json({ success: true, folder })
			} catch (error) {
				res.status(400).json({ success: false, error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Remove a folder
		app.delete("/api/admin/folders/:id", async (req: Request, res: Response) => {
			try {
				const id = req.params.id as string
				if (!this.folderManager) {
					res.status(500).json({ success: false, error: "Server not initialized" })
					return
				}

				const removed = await this.folderManager.removeFolder(id)
				if (removed) {
					res.json({ success: true, folder: removed })
				} else {
					res.status(404).json({ success: false, error: "Folder not found" })
				}
			} catch (error) {
				res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Re-enrich a folder (re-process with LSP without clearing index)
		app.post("/api/admin/folders/:id/reenrich", async (req: Request, res: Response) => {
			try {
				const id = req.params.id as string
				if (!this.folderManager) {
					res.status(500).json({ success: false, error: "Server not initialized" })
					return
				}

				const indexer = this.folderManager.getFolder(id)
				if (!indexer) {
					res.status(404).json({ success: false, error: "Folder not found" })
					return
				}

				// Start re-enrichment in background
				res.json({ success: true, message: "Re-enrichment started" })

				this.folderManager.reEnrich(id).catch((error) => {
					console.error(`[CodeSearch] Re-enrich failed for ${id}:`, error)
				})
			} catch (error) {
				res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Clear and reindex a folder
		app.post("/api/admin/folders/:id/reindex", async (req: Request, res: Response) => {
			try {
				const id = req.params.id as string
				if (!this.folderManager) {
					res.status(500).json({ success: false, error: "Server not initialized" })
					return
				}

				const indexer = this.folderManager.getFolder(id)
				if (!indexer) {
					res.status(404).json({ success: false, error: "Folder not found" })
					return
				}

				// Clear and start reindexing in background
				res.json({ success: true, message: "Reindexing started" })

				// Run reindex in background
				indexer.clearIndex().then(() => {
					return this.folderManager!.startIndexing(id)
				}).catch((error) => {
					console.error(`[CodeSearch] Reindex failed for ${id}:`, error)
				})
			} catch (error) {
				res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Pause indexing for a folder
		app.post("/api/admin/folders/:id/pause", async (req: Request, res: Response) => {
			try {
				const id = req.params.id as string
				if (!this.folderManager) {
					res.status(500).json({ success: false, error: "Server not initialized" })
					return
				}

				const indexer = this.folderManager.getFolder(id)
				if (!indexer) {
					res.status(404).json({ success: false, error: "Folder not found" })
					return
				}

				indexer.pause()
				res.json({ success: true, status: indexer.currentStatus })
			} catch (error) {
				res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Resume indexing for a folder
		app.post("/api/admin/folders/:id/resume", async (req: Request, res: Response) => {
			try {
				const id = req.params.id as string
				if (!this.folderManager) {
					res.status(500).json({ success: false, error: "Server not initialized" })
					return
				}

				const indexer = this.folderManager.getFolder(id)
				if (!indexer) {
					res.status(404).json({ success: false, error: "Folder not found" })
					return
				}

				indexer.resume()
				res.json({ success: true, status: indexer.currentStatus })
			} catch (error) {
				res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Update folder settings
		app.patch("/api/admin/folders/:id/settings", async (req: Request, res: Response) => {
			try {
				const id = req.params.id as string
				const { lspEnabled, embeddingModel } = req.body

				if (!this.folderManager) {
					res.status(500).json({ success: false, error: "Server not initialized" })
					return
				}

				const updates: Record<string, unknown> = {}
				if (lspEnabled !== undefined) {
					updates.lspEnabled = Boolean(lspEnabled)
				}
				if (embeddingModel !== undefined) {
					// Allow null/empty to clear (use global default)
					updates.embeddingModel = embeddingModel || undefined
				}

				if (Object.keys(updates).length === 0) {
					res.status(400).json({ success: false, error: "No valid settings provided" })
					return
				}

				await updateFolder(id, updates)
				res.json({ success: true, updates })
			} catch (error) {
				res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Get folder relationships (worktrees)
		app.get("/api/admin/folders/relationships", async (_req: Request, res: Response) => {
			try {
				if (!this.folderManager) {
					res.status(400).json({ error: "Server not initialized" })
					return
				}

				const relationships = await this.folderManager.getFolderRelationships()
				const result: Array<{ gitCommonDir: string; baseRepo: any; worktrees: any[] }> = []

				for (const [gitCommonDir, { baseRepo, worktrees }] of relationships) {
					result.push({
						gitCommonDir,
						baseRepo,
						worktrees,
					})
				}

				res.json({ relationships: result })
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Find orphaned folders
		app.get("/api/admin/folders/orphaned", async (_req: Request, res: Response) => {
			try {
				if (!this.folderManager) {
					res.status(400).json({ error: "Server not initialized" })
					return
				}

				const orphaned = await this.folderManager.findOrphanedFolders()
				res.json({ orphaned })
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Cleanup orphaned folders
		app.post("/api/admin/folders/cleanup", async (_req: Request, res: Response) => {
			try {
				if (!this.folderManager) {
					res.status(400).json({ success: false, error: "Server not initialized" })
					return
				}

				const removed = await this.folderManager.cleanupOrphanedFolders()
				res.json({
					success: true,
					removed: removed.map(f => ({ id: f.id, path: f.path, name: f.name })),
					count: removed.length,
				})
			} catch (error) {
				res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Validate all folders
		app.post("/api/admin/folders/validate", async (_req: Request, res: Response) => {
			try {
				if (!this.folderManager) {
					res.status(400).json({ success: false, error: "Server not initialized" })
					return
				}

				const { valid, orphaned } = await this.folderManager.validateFolders()
				res.json({
					success: true,
					valid: valid.length,
					orphaned: orphaned.map(f => ({ id: f.id, path: f.path, name: f.name })),
				})
			} catch (error) {
				res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Get embedding cache stats
		app.get("/api/admin/embedding-cache", async (_req: Request, res: Response) => {
			try {
				if (!this.folderManager) {
					res.json({ stats: null })
					return
				}

				const stats = this.folderManager.getEmbeddingCacheStats()
				res.json({
					stats,
					sizeMB: stats ? (stats.sizeBytes / (1024 * 1024)).toFixed(2) : null,
				})
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Warm embedding cache from Qdrant
		let cacheWarmingInProgress = false
		app.post("/api/admin/embedding-cache/warm", async (_req: Request, res: Response) => {
			try {
				if (!this.folderManager) {
					res.status(400).json({ success: false, error: "Server not initialized" })
					return
				}

				if (cacheWarmingInProgress) {
					res.status(409).json({ success: false, error: "Cache warming already in progress" })
					return
				}

				cacheWarmingInProgress = true
				res.json({ success: true, message: "Cache warming started" })

				// Run in background
				this.folderManager.warmEmbeddingCache((processed, total) => {
					// Progress is logged to console
				}).then((result) => {
					console.log(`[CacheWarming] Finished: ${result.processed} processed, ${result.cached} cached`)
					cacheWarmingInProgress = false
				}).catch((error) => {
					console.error("[CacheWarming] Failed:", error)
					cacheWarmingInProgress = false
				})
			} catch (error) {
				cacheWarmingInProgress = false
				res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Get cache warming status
		app.get("/api/admin/embedding-cache/warm/status", async (_req: Request, res: Response) => {
			res.json({ inProgress: cacheWarmingInProgress })
		})

		// Admin API - Get LSP status
		app.get("/api/admin/lsp/status", async (_req: Request, res: Response) => {
			try {
				const config = await loadServerConfig()
				if (!config.lspEnabled) {
					res.json({ enabled: false, servers: {}, stats: null })
					return
				}

				if (!this.folderManager) {
					res.json({ enabled: true, servers: {}, stats: null, error: "Server not initialized" })
					return
				}

				const statuses = this.folderManager.getLspStatuses()
				const servers: Record<string, string> = {}
				if (statuses) {
					for (const [lang, status] of statuses) {
						servers[lang] = status
					}
				}

				const stats = this.folderManager.getLspStats()

				res.json({
					enabled: true,
					servers,
					stats,
					config: {
						timeout: config.lspTimeout,
						maxConcurrentRequests: config.lspMaxConcurrentRequests,
						useOmniSharp: config.lspUseOmniSharp,
					},
				})
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Get settings
		app.get("/api/admin/settings", async (_req: Request, res: Response) => {
			try {
				const config = await loadServerConfig()
				res.json({
					fileWatcherPollInterval: config.fileWatcherPollInterval,
					parsingConcurrency: config.parsingConcurrency,
					modelId: config.modelId,
					modelContextSizes: config.modelContextSizes,
				})
			} catch (error) {
				res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" })
			}
		})

		// Admin API - Update settings
		app.patch("/api/admin/settings", async (req: Request, res: Response) => {
			try {
				const { fileWatcherPollInterval, parsingConcurrency } = req.body
				const updates: Record<string, unknown> = {}

				if (fileWatcherPollInterval !== undefined) {
					const interval = Number(fileWatcherPollInterval)
					if (isNaN(interval) || interval < 50 || interval > 5000) {
						res.status(400).json({ error: "fileWatcherPollInterval must be between 50 and 5000" })
						return
					}
					updates.fileWatcherPollInterval = interval
				}

				if (parsingConcurrency !== undefined) {
					const concurrency = Number(parsingConcurrency)
					if (isNaN(concurrency) || concurrency < 1 || concurrency > 50) {
						res.status(400).json({ error: "parsingConcurrency must be between 1 and 50" })
						return
					}
					updates.parsingConcurrency = concurrency
				}

				const newConfig = await saveServerConfig(updates)

				// Update the folder manager with new settings
				if (this.folderManager) {
					if (updates.fileWatcherPollInterval) {
						this.folderManager.updateFileWatcherOptions({ pollInterval: newConfig.fileWatcherPollInterval })
					}
					if (updates.parsingConcurrency) {
						this.folderManager.updateIndexingOptions({ parsingConcurrency: newConfig.parsingConcurrency })
					}
				}

				res.json({
					fileWatcherPollInterval: newConfig.fileWatcherPollInterval,
					parsingConcurrency: newConfig.parsingConcurrency,
				})
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

		return new Promise<void>((resolve, reject) => {
			this.httpServer = app.listen(port, () => {
				console.error(`[CodeSearch] Server running on http://localhost:${port}`)
				console.error(`[CodeSearch] SSE endpoint: http://localhost:${port}/sse`)
				console.error(`[CodeSearch] Admin UI: http://localhost:${port}/admin`)

				if (useTray) {
					tray = new SystemTray(port, { onStop: shutdown })
					tray.start()
					console.error("[CodeSearch] System tray icon active")
				}
			})

			this.httpServer.on('error', reject)
			// Never resolve - keep the server running
		})
	}

	async shutdown(): Promise<void> {
		if (this.folderManager) {
			await this.folderManager.dispose()
		}
		if (this.httpServer) {
			this.httpServer.close()
		}
		await this.server.close()
	}

	/**
	 * Auto-warm the embedding cache on startup if Qdrant has more data than the cache
	 */
	private async autoWarmCache(vectorStore: QdrantVectorStore): Promise<void> {
		if (!this.folderManager) return

		try {
			// Get counts to compare
			const qdrantCount = await vectorStore.getPointCount()
			const cacheStats = this.folderManager.getEmbeddingCacheStats()
			const cacheCount = cacheStats?.modelEntries ?? 0

			// If Qdrant has significantly more points than cache, warm it
			// Use 90% threshold to account for slight variations
			if (qdrantCount > 0 && cacheCount < qdrantCount * 0.9) {
				console.error(`[CodeSearch] Auto-warming cache: Qdrant has ${qdrantCount} points, cache has ${cacheCount}`)
				const result = await this.folderManager.warmEmbeddingCache()
				console.error(`[CodeSearch] Cache warming complete: ${result.cached} new embeddings cached`)
			} else if (qdrantCount > 0) {
				console.error(`[CodeSearch] Cache already warm: ${cacheCount} embeddings for ${qdrantCount} points`)
			}
		} catch (error) {
			// Non-fatal - just log and continue
			console.error(`[CodeSearch] Auto cache warming skipped: ${error instanceof Error ? error.message : error}`)
		}
	}
}
