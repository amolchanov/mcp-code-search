import * as path from "path"
import type { IEmbedder, IVectorStore, VectorStoreSearchResult, SearchFilter, Payload } from "../types/index.js"
import { getAllFolders, getFolderByPath } from "../config/store.js"
import { queryLogger } from "../query-logger.js"

export interface SearchOptions {
	query: string
	folderId?: string
	folderPath?: string
	fileTypes?: string[]
	pathPrefix?: string
	minScore?: number
	maxResults?: number
}

export interface SearchResult {
	folderId: string
	folderName: string
	folderPath: string
	filePath: string
	absolutePath: string
	codeChunk: string
	startLine: number
	endLine: number
	score: number
}

/**
 * Search service for semantic code search
 */
export class SearchService {
	constructor(
		private readonly embedder: IEmbedder,
		private readonly vectorStore: IVectorStore
	) {}

	async search(options: SearchOptions): Promise<SearchResult[]> {
		const { query, folderId, folderPath, fileTypes, pathPrefix, minScore, maxResults } = options
		const startTime = Date.now()
		console.error(`[SearchService] Search query: "${query}"`)  // Debug log

		// Resolve folderId from path if needed
		let resolvedFolderId = folderId
		let resolvedFolderPath = folderPath
		if (!resolvedFolderId && folderPath) {
			const folder = await getFolderByPath(folderPath)
			if (folder) {
				resolvedFolderId = folder.id
				resolvedFolderPath = folder.path
			}
		} else if (resolvedFolderId && !resolvedFolderPath) {
			const folders = await getAllFolders()
			const folder = folders.find((f) => f.id === resolvedFolderId)
			if (folder) {
				resolvedFolderPath = folder.path
			}
		}

		// Create embedding for query
		const { embeddings } = await this.embedder.createEmbeddings([query])
		if (embeddings.length === 0) {
			throw new Error("Failed to create embedding for query")
		}
		const queryVector = embeddings[0]

		// Build search filter
		const filter: SearchFilter = {}
		if (resolvedFolderId) {
			filter.folderId = resolvedFolderId
		}
		if (fileTypes && fileTypes.length > 0) {
			filter.fileTypes = fileTypes
		}
		if (pathPrefix) {
			filter.pathPrefix = pathPrefix
		}

		// Execute search
		const rawResults = await this.vectorStore.search(queryVector, filter, minScore, maxResults)

		// Get folder information for results
		const folders = await getAllFolders()
		const folderMap = new Map(folders.map((f) => [f.id, f]))

		// Transform results
		const results: SearchResult[] = []

		for (const result of rawResults) {
			const payload = result.payload as Payload | null
			if (!payload) continue

			const folder = folderMap.get(payload.folderId)
			if (!folder) continue

			results.push({
				folderId: payload.folderId,
				folderName: folder.name,
				folderPath: folder.path,
				filePath: payload.filePath,
				absolutePath: path.join(folder.path, payload.filePath),
				codeChunk: payload.codeChunk,
				startLine: payload.startLine,
				endLine: payload.endLine,
				score: result.score,
			})
		}

		// Log the query with results
		const executionTimeMs = Date.now() - startTime
		console.error(`[SearchService] Logging query, results: ${results.length}, time: ${executionTimeMs}ms`)  // Debug log
		queryLogger.logQuery({
			query,
			folderId: resolvedFolderId || null,
			folderPath: resolvedFolderPath || null,
			timestamp: Date.now(),
			resultsCount: results.length,
			results: results.map(r => ({
				filePath: r.filePath,
				startLine: r.startLine,
				endLine: r.endLine,
				score: r.score,
				// Truncate code snippet to first 500 chars for logging
				codeSnippet: r.codeChunk.length > 500 ? r.codeChunk.substring(0, 500) + '...' : r.codeChunk,
			})),
			minScore,
			maxResults,
			executionTimeMs,
		}).then(() => {
			console.error("[SearchService] Query logged successfully")  // Debug log
		}).catch((err) => {
			console.error("[SearchService] Failed to log query:", err)
		})

		return results
	}
}
