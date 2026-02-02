import * as path from "path"
import type { IEmbedder, IVectorStore, IndexedFolder, FolderProgress, IndexingError, FolderStatus } from "../types/index.js"
import { FolderIndexer, generateFolderId, getFolderNameFromPath } from "./folder-indexer.js"
import type { LSPOptions, IndexingOptions } from "./folder-indexer.js"
import type { FileWatcherOptions } from "./file-watcher.js"
import {
	addFolder,
	removeFolder,
	getAllFolders,
	updateFolder,
	getFolder,
	getFolderByPath,
} from "../config/store.js"
import { isDirectory } from "../utils/fs.js"
import { EmbeddingCache } from "../cache/embedding-cache.js"
import { QdrantVectorStore } from "../vector-store/qdrant-client.js"
import { getWorktreeInfo, folderExists, isSameRepository } from "../utils/git.js"
import { resolveIncludeExtensions } from "../utils/ignore.js"

export interface FolderManagerCallbacks {
	onFolderAdded?: (folder: IndexedFolder) => void
	onFolderRemoved?: (folderId: string) => void
	onStatusChange?: (folderId: string, status: FolderStatus) => void
	onProgress?: (progress: FolderProgress) => void
	onError?: (error: IndexingError) => void
}

/**
 * Orchestrates multiple folder indexers
 */
export class FolderManager {
	private indexers: Map<string, FolderIndexer> = new Map()
	private isInitialized = false

	constructor(
		private readonly embedder: IEmbedder,
		private readonly vectorStore: IVectorStore,
		private readonly wasmDirectory?: string,
		private readonly callbacks?: FolderManagerCallbacks,
		private fileWatcherOptions?: FileWatcherOptions,
		private readonly modelId?: string,
		private readonly lspOptions?: LSPOptions,
		private indexingOptions?: IndexingOptions
	) {}

	updateIndexingOptions(options: IndexingOptions): void {
		this.indexingOptions = { ...this.indexingOptions, ...options }
	}

	updateFileWatcherOptions(options: FileWatcherOptions): void {
		this.fileWatcherOptions = options
	}

	async initialize(): Promise<void> {
		if (this.isInitialized) return

		// Validate folders exist on disk and mark orphaned ones
		const { valid, orphaned } = await this.validateFolders()

		if (orphaned.length > 0) {
			console.log(`[FolderManager] Found ${orphaned.length} orphaned folder(s): ${orphaned.map(f => f.path).join(", ")}`)
		}

		// Only initialize indexers for valid folders
		for (const folder of valid) {
			const indexer = new FolderIndexer(folder, this.embedder, this.vectorStore, this.wasmDirectory, {
				onStatusChange: (folderId, status) => {
					this.callbacks?.onStatusChange?.(folderId, status)
				},
				onProgress: (progress) => {
					this.callbacks?.onProgress?.(progress)
				},
				onError: (error) => {
					this.callbacks?.onError?.(error)
				},
			}, this.fileWatcherOptions, this.modelId, this.lspOptions, this.indexingOptions)
			await indexer.initialize()
			this.indexers.set(folder.id, indexer)
		}

		this.isInitialized = true
	}

	async addFolder(folderPath: string, startIndexing: boolean = true, includeExtensions?: string[]): Promise<IndexedFolder> {
		const normalizedPath = path.normalize(folderPath)

		// Check if path exists and is a directory
		if (!(await isDirectory(normalizedPath))) {
			throw new Error(`Path does not exist or is not a directory: ${normalizedPath}`)
		}

		// Check if already added
		const existing = await getFolderByPath(normalizedPath)
		if (existing) {
			throw new Error(`Folder already indexed: ${normalizedPath}`)
		}

		// Resolve extensions: programmatic > .cs-mcp-include file > all supported
		const resolvedExtensions = await resolveIncludeExtensions(normalizedPath, includeExtensions)
		
		// Normalize extensions (ensure they start with a dot and are lowercase)
		const normalizedExtensions = resolvedExtensions?.map(ext => {
			const normalized = ext.toLowerCase()
			return normalized.startsWith('.') ? normalized : `.${normalized}`
		})

		// Check if this is a git worktree
		const worktreeInfo = await getWorktreeInfo(normalizedPath)
		let baseRepoId: string | undefined
		let baseRepoFolder: IndexedFolder | undefined

		if (worktreeInfo.isWorktree && worktreeInfo.mainRepoPath) {
			// Check if the base repo is already indexed
			baseRepoFolder = await getFolderByPath(worktreeInfo.mainRepoPath)

			if (!baseRepoFolder) {
				// Auto-add the base repo first
				console.log(`[FolderManager] Detected worktree, auto-adding base repo: ${worktreeInfo.mainRepoPath}`)
				try {
					baseRepoFolder = await this.addFolderInternal(worktreeInfo.mainRepoPath, {
						isWorktree: false,
						gitCommonDir: worktreeInfo.gitCommonDir,
					}, startIndexing, normalizedExtensions)
				} catch (error) {
					console.warn(`[FolderManager] Failed to auto-add base repo: ${error}`)
					// Continue without base repo link
				}
			} else if (!baseRepoFolder.gitCommonDir && worktreeInfo.gitCommonDir) {
				// Backfill gitCommonDir on existing base repo
				console.log(`[FolderManager] Backfilling gitCommonDir on existing base repo: ${baseRepoFolder.path}`)
				await updateFolder(baseRepoFolder.id, { gitCommonDir: worktreeInfo.gitCommonDir })
				baseRepoFolder.gitCommonDir = worktreeInfo.gitCommonDir
			}

			if (baseRepoFolder) {
				baseRepoId = baseRepoFolder.id
			}
		}

		const folder: IndexedFolder = {
			id: generateFolderId(),
			path: normalizedPath,
			name: getFolderNameFromPath(normalizedPath),
			status: "pending",
			addedAt: Date.now(),
			isWorktree: worktreeInfo.isWorktree || undefined,
			baseRepoId,
			gitCommonDir: worktreeInfo.gitCommonDir,
			includeExtensions: normalizedExtensions,
		}

		await addFolder(folder)

		const indexer = new FolderIndexer(folder, this.embedder, this.vectorStore, this.wasmDirectory, {
			onStatusChange: (folderId, status) => {
				this.callbacks?.onStatusChange?.(folderId, status)
			},
			onProgress: (progress) => {
				this.callbacks?.onProgress?.(progress)
			},
			onError: (error) => {
				this.callbacks?.onError?.(error)
			},
		}, this.fileWatcherOptions, this.modelId, this.lspOptions, this.indexingOptions)
		await indexer.initialize()
		this.indexers.set(folder.id, indexer)

		this.callbacks?.onFolderAdded?.(folder)

		if (startIndexing) {
			// Start indexing in the background
			this.startIndexing(folder.id).catch(console.error)
		}

		return folder
	}

	/**
	 * Internal method to add a folder with worktree metadata
	 */
	private async addFolderInternal(
		folderPath: string,
		worktreeMeta: { isWorktree: boolean; gitCommonDir?: string; baseRepoId?: string },
		startIndexing: boolean,
		includeExtensions?: string[]
	): Promise<IndexedFolder> {
		const normalizedPath = path.normalize(folderPath)

		// Check if path exists and is a directory
		if (!(await isDirectory(normalizedPath))) {
			throw new Error(`Path does not exist or is not a directory: ${normalizedPath}`)
		}

		// Check if already added
		const existing = await getFolderByPath(normalizedPath)
		if (existing) {
			return existing // Return existing instead of error for internal calls
		}

		const folder: IndexedFolder = {
			id: generateFolderId(),
			path: normalizedPath,
			name: getFolderNameFromPath(normalizedPath),
			status: "pending",
			addedAt: Date.now(),
			isWorktree: worktreeMeta.isWorktree || undefined,
			baseRepoId: worktreeMeta.baseRepoId,
			gitCommonDir: worktreeMeta.gitCommonDir,
			includeExtensions,
		}

		await addFolder(folder)

		const indexer = new FolderIndexer(folder, this.embedder, this.vectorStore, this.wasmDirectory, {
			onStatusChange: (folderId, status) => {
				this.callbacks?.onStatusChange?.(folderId, status)
			},
			onProgress: (progress) => {
				this.callbacks?.onProgress?.(progress)
			},
			onError: (error) => {
				this.callbacks?.onError?.(error)
			},
		}, this.fileWatcherOptions, this.modelId, this.lspOptions, this.indexingOptions)
		await indexer.initialize()
		this.indexers.set(folder.id, indexer)

		this.callbacks?.onFolderAdded?.(folder)

		if (startIndexing) {
			this.startIndexing(folder.id).catch(console.error)
		}

		return folder
	}

	async removeFolder(folderId: string): Promise<IndexedFolder | undefined> {
		const indexer = this.indexers.get(folderId)
		if (indexer) {
			await indexer.stopWatching()
			await this.vectorStore.deletePointsByFolderId(folderId)
			await indexer.dispose()
			this.indexers.delete(folderId)
		}

		const removed = await removeFolder(folderId)
		if (removed) {
			this.callbacks?.onFolderRemoved?.(folderId)
		}
		return removed
	}

	async removeFolderByPath(folderPath: string): Promise<IndexedFolder | undefined> {
		const folder = await getFolderByPath(folderPath)
		if (folder) {
			return this.removeFolder(folder.id)
		}
		return undefined
	}

	async listFolders(): Promise<IndexedFolder[]> {
		return getAllFolders()
	}

	getFolder(folderId: string): FolderIndexer | undefined {
		return this.indexers.get(folderId)
	}

	async startIndexing(folderId: string): Promise<void> {
		const indexer = this.indexers.get(folderId)
		if (!indexer) {
			throw new Error(`Folder not found: ${folderId}`)
		}

		try {
			await indexer.startIndexing()
			await indexer.startWatching()
		} catch (error) {
			console.error(`Failed to start indexing for folder ${folderId}:`, error)
			throw error
		}
	}

	async reEnrich(folderId: string): Promise<void> {
		const indexer = this.indexers.get(folderId)
		if (!indexer) {
			throw new Error(`Folder not found: ${folderId}`)
		}

		try {
			await indexer.reEnrich()
		} catch (error) {
			console.error(`Failed to re-enrich folder ${folderId}:`, error)
			throw error
		}
	}

	async stopIndexing(folderId: string): Promise<void> {
		const indexer = this.indexers.get(folderId)
		if (indexer) {
			await indexer.stopWatching()
		}
	}

	pauseIndexing(folderId: string): void {
		const indexer = this.indexers.get(folderId)
		if (indexer) {
			indexer.pause()
		}
	}

	resumeFolderIndexing(folderId: string): void {
		const indexer = this.indexers.get(folderId)
		if (indexer) {
			indexer.resume()
		}
	}

	async reindex(folderId: string): Promise<void> {
		const indexer = this.indexers.get(folderId)
		if (!indexer) {
			throw new Error(`Folder not found: ${folderId}`)
		}

		await indexer.clearIndex()
		await indexer.startIndexing()
		await indexer.startWatching()
	}

	async clearIndex(folderId: string): Promise<void> {
		const indexer = this.indexers.get(folderId)
		if (!indexer) {
			throw new Error(`Folder not found: ${folderId}`)
		}

		await indexer.clearIndex()
	}

	async clearAllIndexes(): Promise<void> {
		for (const indexer of this.indexers.values()) {
			await indexer.clearIndex()
		}
	}

	getStatus(folderId: string): { status: FolderStatus; progress: FolderProgress } | undefined {
		const indexer = this.indexers.get(folderId)
		if (!indexer) return undefined

		return {
			status: indexer.currentStatus,
			progress: indexer.currentProgress,
		}
	}

	getAllStatuses(): Map<string, { status: FolderStatus; progress: FolderProgress }> {
		const statuses = new Map<string, { status: FolderStatus; progress: FolderProgress }>()

		for (const [folderId, indexer] of this.indexers) {
			statuses.set(folderId, {
				status: indexer.currentStatus,
				progress: indexer.currentProgress,
			})
		}

		return statuses
	}

	getErrors(folderId?: string, limit?: number, since?: number): IndexingError[] {
		let errors: IndexingError[] = []

		if (folderId) {
			const indexer = this.indexers.get(folderId)
			if (indexer) {
				errors = indexer.recentErrors
			}
		} else {
			for (const indexer of this.indexers.values()) {
				errors.push(...indexer.recentErrors)
			}
		}

		// Filter by timestamp if specified
		if (since) {
			errors = errors.filter((e) => e.timestamp >= since)
		}

		// Sort by timestamp descending
		errors.sort((a, b) => b.timestamp - a.timestamp)

		// Apply limit
		if (limit && limit > 0) {
			errors = errors.slice(0, limit)
		}

		return errors
	}

	async resumeIndexing(): Promise<void> {
		const folders = await getAllFolders()

		for (const folder of folders) {
			const indexer = this.indexers.get(folder.id)
			if (!indexer) continue

			if (folder.status === "indexed") {
				// Start watching for changes
				await indexer.startWatching()
			} else if (folder.status === "indexing" || folder.status === "pending") {
				// Resume indexing
				this.startIndexing(folder.id).catch(console.error)
			}
		}
	}

	async dispose(): Promise<void> {
		for (const indexer of this.indexers.values()) {
			await indexer.dispose()
		}
		this.indexers.clear()
	}

	/**
	 * Get indexed file count for a specific folder
	 */
	getFileCount(folderId: string): number {
		const indexer = this.indexers.get(folderId)
		if (indexer) {
			return indexer.fileCount
		}
		return 0
	}

	/**
	 * Get indexed chunk count (vector points) for a specific folder
	 */
	async getChunkCount(folderId: string): Promise<number> {
		if (this.vectorStore.getPointCountForFolder) {
			return this.vectorStore.getPointCountForFolder(folderId)
		}
		return 0
	}

	/**
	 * Get all worktrees linked to a base repo
	 */
	async getLinkedWorktrees(baseRepoId: string): Promise<IndexedFolder[]> {
		const folders = await getAllFolders()
		return folders.filter(f => f.baseRepoId === baseRepoId)
	}

	/**
	 * Find orphaned folders (folders that no longer exist on disk)
	 */
	async findOrphanedFolders(): Promise<IndexedFolder[]> {
		const folders = await getAllFolders()
		const orphaned: IndexedFolder[] = []

		for (const folder of folders) {
			if (!(await folderExists(folder.path))) {
				orphaned.push(folder)
			}
		}

		return orphaned
	}

	/**
	 * Mark folders as orphaned if they no longer exist on disk
	 */
	async validateFolders(): Promise<{ valid: IndexedFolder[]; orphaned: IndexedFolder[] }> {
		const folders = await getAllFolders()
		const valid: IndexedFolder[] = []
		const orphaned: IndexedFolder[] = []

		for (const folder of folders) {
			const exists = await folderExists(folder.path)
			if (exists) {
				// Clear orphaned flag if it was set
				if (folder.isOrphaned) {
					folder.isOrphaned = false
					await updateFolder(folder.id, { isOrphaned: false })
				}
				valid.push(folder)
			} else {
				// Mark as orphaned
				if (!folder.isOrphaned) {
					folder.isOrphaned = true
					await updateFolder(folder.id, { isOrphaned: true })
				}
				orphaned.push(folder)
			}
		}

		return { valid, orphaned }
	}

	/**
	 * Clean up orphaned folders (remove from config and vector store)
	 */
	async cleanupOrphanedFolders(): Promise<IndexedFolder[]> {
		const orphaned = await this.findOrphanedFolders()
		const removed: IndexedFolder[] = []

		for (const folder of orphaned) {
			try {
				await this.removeFolder(folder.id)
				removed.push(folder)
				console.log(`[FolderManager] Cleaned up orphaned folder: ${folder.path}`)
			} catch (error) {
				console.error(`[FolderManager] Failed to cleanup orphaned folder ${folder.path}:`, error)
			}
		}

		return removed
	}

	/**
	 * Get folder relationships for display (base repos and their worktrees)
	 */
	async getFolderRelationships(): Promise<Map<string, { baseRepo: IndexedFolder; worktrees: IndexedFolder[] }>> {
		const folders = await getAllFolders()
		const relationships = new Map<string, { baseRepo: IndexedFolder; worktrees: IndexedFolder[] }>()

		// Normalize path for grouping (case-insensitive on Windows)
		const normalizeGitDir = (p: string): string => {
			const normalized = path.normalize(p)
			return process.platform === "win32" ? normalized.toLowerCase() : normalized
		}

		// Group by gitCommonDir (case-insensitive on Windows)
		const byCommonDir = new Map<string, IndexedFolder[]>()
		for (const folder of folders) {
			if (folder.gitCommonDir) {
				const key = normalizeGitDir(folder.gitCommonDir)
				const existing = byCommonDir.get(key) || []
				existing.push(folder)
				byCommonDir.set(key, existing)
			}
		}

		// Build relationships
		for (const [commonDir, relatedFolders] of byCommonDir) {
			const baseRepo = relatedFolders.find(f => !f.isWorktree)
			const worktrees = relatedFolders.filter(f => f.isWorktree)

			if (baseRepo) {
				relationships.set(commonDir, { baseRepo, worktrees })
			}
		}

		return relationships
	}

	/**
	 * Get embedding cache statistics (shared across all folders for same model)
	 */
	async getEmbeddingCacheStats(): Promise<{ totalEntries: number; modelEntries: number; sizeBytes: number } | null> {
		// Get stats from any indexer (they all share the same cache)
		const indexer = this.indexers.values().next().value
		if (!indexer) return null
		return await indexer.getEmbeddingCacheStats()
	}

	/**
	 * Get LSP server statuses (if LSP is enabled)
	 */
	getLspStatuses(): Map<string, string> | null {
		// Get from any indexer that has LSP enabled
		for (const indexer of this.indexers.values()) {
			const status = indexer.lspStatus
			if (status) return status
		}
		return null
	}

	/**
	 * Get LSP enrichment statistics
	 */
	getLspStats(): {
		filesProcessed: number
		filesSkippedUnavailable: number
		filesSkippedUnsupported: number
		filesWithErrors: number
		blocksProcessed: number
		blocksEnriched: number
		blocksNoData: number
		blocksFromCache: number
	} | null {
		// Get from any indexer that has LSP enabled
		for (const indexer of this.indexers.values()) {
			const stats = indexer.lspStats
			if (stats) return stats
		}
		return null
	}

	/**
	 * Warm the embedding cache from existing Qdrant data
	 * This populates the SQLite cache with embeddings already stored in Qdrant
	 */
	async warmEmbeddingCache(
		onProgress?: (processed: number, total: number) => void
	): Promise<{ processed: number; cached: number }> {
		// Check if vectorStore is a QdrantVectorStore with scroll capability
		if (!(this.vectorStore instanceof QdrantVectorStore)) {
			throw new Error("Cache warming requires QdrantVectorStore")
		}

		const qdrantStore = this.vectorStore as QdrantVectorStore

		// Create a temporary embedding cache instance for warming
		const cacheModelId = this.modelId || this.embedder.embedderInfo.name
		const embeddingCache = new EmbeddingCache(cacheModelId)
		await embeddingCache.initialize()

		try {
			// Get total count for progress
			const totalPoints = await qdrantStore.getPointCount()
			let processed = 0
			let cached = 0

			console.log(`[CacheWarming] Starting cache warm from ${totalPoints} points...`)

			// Scroll through all points
			for await (const batch of qdrantStore.scrollAllPoints(100)) {
				const entries: Array<{ segmentHash: string; embedding: number[] }> = []

				for (const point of batch) {
					// Check if already cached
					const existing = embeddingCache.getEmbedding(point.segmentHash)
					if (!existing) {
						entries.push({
							segmentHash: point.segmentHash,
							embedding: point.vector,
						})
					}
				}

				if (entries.length > 0) {
					embeddingCache.setEmbeddings(entries)
					cached += entries.length
				}

				processed += batch.length
				onProgress?.(processed, totalPoints)

				if (processed % 1000 === 0) {
					console.log(`[CacheWarming] Processed ${processed}/${totalPoints} points, cached ${cached} new embeddings`)
				}
			}

			console.log(`[CacheWarming] Complete: processed ${processed} points, cached ${cached} new embeddings`)
			return { processed, cached }
		} finally {
			embeddingCache.close()
		}
	}
}
