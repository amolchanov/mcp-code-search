import { v4 as uuidv4 } from "uuid"
import * as path from "path"
import type { IEmbedder, IVectorStore, FolderStatus, FolderProgress, IndexingError, IndexedFolder } from "../types/index.js"
import { CodeParser } from "../parser/code-parser.js"
import { FileCacheManager } from "../cache/file-cache.js"
import { EmbeddingCache } from "../cache/embedding-cache.js"
import { DirectoryScanner, ScanResult } from "./scanner.js"
import { FileWatcher, FileWatcherOptions } from "./file-watcher.js"
import { updateFolder } from "../config/store.js"
import type { LSPEnricherOptions, ILSPEnricher } from "../lsp/types.js"
import { LSPServerManager } from "../lsp/lsp-server-manager.js"
import { LSPEnricher } from "../lsp/lsp-enricher.js"
import { LSPCache } from "../lsp/lsp-cache.js"

export interface FolderIndexerCallbacks {
	onStatusChange?: (folderId: string, status: FolderStatus) => void
	onProgress?: (progress: FolderProgress) => void
	onError?: (error: IndexingError) => void
}

/**
 * Manages indexing for a single folder
 */
export interface LSPOptions {
	enabled: boolean
	timeout?: number
	maxConcurrentRequests?: number
	useOmniSharp?: boolean
}

export interface IndexingOptions {
	parsingConcurrency?: number
}

export class FolderIndexer {
	private status: FolderStatus
	private fileWatcher: FileWatcher | null = null
	private cacheManager: FileCacheManager
	private embeddingCache: EmbeddingCache
	private codeParser: CodeParser
	private scanner: DirectoryScanner | null = null
	private errors: IndexingError[] = []
	private progress: FolderProgress
	private _isPaused: boolean = false

	// LSP components
	private lspServerManager: LSPServerManager | null = null
	private lspCache: LSPCache | null = null
	private lspEnricher: ILSPEnricher | null = null

	constructor(
		private readonly folder: IndexedFolder,
		private readonly embedder: IEmbedder,
		private readonly vectorStore: IVectorStore,
		private readonly wasmDirectory?: string,
		private readonly callbacks?: FolderIndexerCallbacks,
		private readonly fileWatcherOptions?: FileWatcherOptions,
		private readonly modelId?: string,
		private readonly lspOptions?: LSPOptions,
		private readonly indexingOptions?: IndexingOptions
	) {
		// Restore status from persisted folder config
		this.status = folder.status || "pending"
		this.cacheManager = new FileCacheManager(folder.id)
		// Use modelId or embedder info for cache key
		const cacheModelId = modelId || embedder.embedderInfo.name
		this.embeddingCache = new EmbeddingCache(cacheModelId)
		this.codeParser = new CodeParser(wasmDirectory)
		this.progress = {
			folderId: folder.id,
			status: this.status,
			processedFiles: 0,
			totalFiles: 0,
			indexedBlocks: 0,
		}
	}

	get folderId(): string {
		return this.folder.id
	}

	get folderPath(): string {
		return this.folder.path
	}

	get currentStatus(): FolderStatus {
		return this.status
	}

	get currentProgress(): FolderProgress {
		return { ...this.progress }
	}

	get recentErrors(): IndexingError[] {
		return [...this.errors]
	}

	get fileCount(): number {
		return this.cacheManager.getFileCount()
	}

	get embeddingCacheStats(): { totalEntries: number; modelEntries: number; sizeBytes: number } {
		return this.embeddingCache.getStats()
	}

	get lspStatus(): Map<string, string> | null {
		if (!this.lspEnricher) return null
		return this.lspEnricher.getStatus()
	}

	get lspStats(): {
		filesProcessed: number
		filesSkippedUnavailable: number
		filesSkippedUnsupported: number
		filesWithErrors: number
		blocksProcessed: number
		blocksEnriched: number
		blocksNoData: number
		blocksFromCache: number
	} | null {
		if (!this.lspEnricher) return null
		return this.lspEnricher.getStats()
	}

	get isPaused(): boolean {
		return this._isPaused
	}

	pause(): void {
		if (this.status === "indexing" && !this._isPaused) {
			this._isPaused = true
			this.setStatus("paused")
			console.log(`[${this.folder.name}] Indexing paused`)
		}
	}

	resume(): void {
		if (this._isPaused) {
			this._isPaused = false
			this.setStatus("indexing")
			console.log(`[${this.folder.name}] Indexing resumed`)
		}
	}

	private setStatus(status: FolderStatus): void {
		this.status = status
		this.progress.status = status
		this.callbacks?.onStatusChange?.(this.folder.id, status)
		this.callbacks?.onProgress?.(this.progress)

		// Persist status to config
		updateFolder(this.folder.id, { status }).catch(console.error)
	}

	private addError(filePath: string, error: string): void {
		const indexingError: IndexingError = {
			folderId: this.folder.id,
			filePath,
			error,
			timestamp: Date.now(),
		}
		this.errors.push(indexingError)
		// Keep only last 100 errors
		if (this.errors.length > 100) {
			this.errors = this.errors.slice(-100)
		}
		this.callbacks?.onError?.(indexingError)
	}

	async initialize(): Promise<void> {
		await this.cacheManager.initialize()
		await this.embeddingCache.initialize()

		// Determine if LSP should be enabled for this folder
		// Per-folder setting takes precedence over global setting
		// undefined = use global setting (which defaults to enabled)
		const lspEnabledForFolder = this.folder.lspEnabled !== undefined
			? this.folder.lspEnabled
			: this.lspOptions?.enabled ?? true

		// Initialize LSP components if enabled
		if (lspEnabledForFolder && this.lspOptions) {
			try {
				this.lspServerManager = new LSPServerManager({
					useOmniSharp: this.lspOptions.useOmniSharp,
				})
				this.lspCache = new LSPCache()
				await this.lspCache.initialize()
				this.lspEnricher = new LSPEnricher(this.lspServerManager, this.lspCache, {
					enabled: true,
					timeout: this.lspOptions.timeout,
					maxConcurrentRequests: this.lspOptions.maxConcurrentRequests,
				})
				console.log(`[${this.folder.name}] LSP enrichment enabled`)
			} catch (error) {
				console.error(`[${this.folder.name}] Failed to initialize LSP:`, error)
				// Continue without LSP enrichment
				this.lspServerManager = null
				this.lspCache = null
				this.lspEnricher = null
			}
		} else if (this.folder.lspEnabled === false) {
			console.log(`[${this.folder.name}] LSP enrichment disabled (per-folder setting)`)
		}
	}

	async startIndexing(): Promise<ScanResult> {
		this.setStatus("indexing")
		this.progress.startTime = Date.now()
		this.progress.processedFiles = 0
		this.progress.indexedBlocks = 0

		try {
			await this.vectorStore.markIndexingIncomplete(this.folder.id)

			this.scanner = new DirectoryScanner(
				this.folder.id,
				this.folder.path,
				this.embedder,
				this.vectorStore,
				this.codeParser,
				this.cacheManager,
				this.embeddingCache,
				this.lspEnricher ?? undefined,
				undefined, // batchSegmentThreshold - use default
				this.indexingOptions?.parsingConcurrency
			)

			const result = await this.scanner.scanDirectory({
				onError: (error) => {
					this.addError("", error.message)
				},
				onBlocksIndexed: (count) => {
					this.progress.indexedBlocks += count
					this.callbacks?.onProgress?.(this.progress)
				},
				onFileParsed: (blockCount) => {
					this.progress.processedFiles++
					this.callbacks?.onProgress?.(this.progress)
				},
				onProgress: (processed, total, currentFile) => {
					this.progress.processedFiles = processed
					this.progress.totalFiles = total
					this.progress.currentFile = currentFile
					this.callbacks?.onProgress?.(this.progress)
				},
				isPaused: () => this._isPaused,
			})

			await this.vectorStore.markIndexingComplete(this.folder.id)

			this.progress.endTime = Date.now()
			this.setStatus("indexed")

			// Update folder metadata
			await updateFolder(this.folder.id, {
				lastIndexedAt: Date.now(),
				fileCount: result.stats.processed,
				errorCount: this.errors.length,
				lastIndexedWithLsp: this.lspEnricher !== null,
				lastIndexedWithModel: this.modelId,
			})

			return result
		} catch (error) {
			console.error(`Error indexing folder ${this.folder.path}:`, error)
			this.addError("", error instanceof Error ? error.message : String(error))
			this.setStatus("error")

			await updateFolder(this.folder.id, {
				lastError: error instanceof Error ? error.message : String(error),
				errorCount: this.errors.length,
			})

			throw error
		}
	}

	async startWatching(): Promise<void> {
		if (this.fileWatcher) {
			await this.fileWatcher.dispose()
		}

		this.fileWatcher = new FileWatcher(
			this.folder.id,
			this.folder.path,
			this.embedder,
			this.vectorStore,
			this.codeParser,
			this.cacheManager,
			{
				onBatchStart: (files) => {
					console.log(`[${this.folder.name}] Processing ${files.length} file changes`)
				},
				onBatchProgress: (processed, total, currentFile) => {
					this.progress.processedFiles = processed
					this.progress.totalFiles = total
					this.progress.currentFile = currentFile
					this.callbacks?.onProgress?.(this.progress)
				},
				onBatchComplete: (results) => {
					console.log(
						`[${this.folder.name}] Batch complete: ${results.success} success, ${results.errors} errors`
					)
				},
				onError: (error) => {
					this.addError("", error.message)
				},
			},
			this.fileWatcherOptions,
			this.embeddingCache,
			this.lspEnricher ?? undefined
		)

		await this.fileWatcher.initialize()
		console.log(`[${this.folder.name}] File watcher started`)
	}

	async stopWatching(): Promise<void> {
		if (this.fileWatcher) {
			await this.fileWatcher.dispose()
			this.fileWatcher = null
			console.log(`[${this.folder.name}] File watcher stopped`)
		}
	}

	async clearIndex(): Promise<void> {
		this.setStatus("pending")

		try {
			await this.vectorStore.deletePointsByFolderId(this.folder.id)
			await this.cacheManager.clearCacheFile()
			this.errors = []

			await updateFolder(this.folder.id, {
				status: "pending",
				lastIndexedAt: undefined,
				fileCount: undefined,
				errorCount: 0,
			})
		} catch (error) {
			console.error(`Error clearing index for folder ${this.folder.path}:`, error)
			this.setStatus("error")
			throw error
		}
	}

	/**
	 * Re-enrich all files without clearing the index.
	 * This clears the file hash cache so all files are re-processed,
	 * but keeps existing embeddings searchable until replaced.
	 */
	async reEnrich(): Promise<ScanResult> {
		this.setStatus("indexing")
		this.progress.startTime = Date.now()
		this.progress.processedFiles = 0
		this.progress.indexedBlocks = 0

		console.log(`[${this.folder.name}] Starting re-enrichment (keeping index live)`)

		try {
			// Clear only the file hash cache - not the vector store
			// This forces all files to be re-processed
			await this.cacheManager.clearCacheFile()

			this.scanner = new DirectoryScanner(
				this.folder.id,
				this.folder.path,
				this.embedder,
				this.vectorStore,
				this.codeParser,
				this.cacheManager,
				this.embeddingCache,
				this.lspEnricher ?? undefined,
				undefined,
				this.indexingOptions?.parsingConcurrency
			)

			const result = await this.scanner.scanDirectory({
				onError: (error) => {
					this.addError("", error.message)
				},
				onBlocksIndexed: (count) => {
					this.progress.indexedBlocks += count
					this.callbacks?.onProgress?.(this.progress)
				},
				onFileParsed: (blockCount) => {
					this.progress.processedFiles++
					this.callbacks?.onProgress?.(this.progress)
				},
				onProgress: (processed, total, currentFile) => {
					this.progress.processedFiles = processed
					this.progress.totalFiles = total
					this.progress.currentFile = currentFile
					this.callbacks?.onProgress?.(this.progress)
				},
				isPaused: () => this._isPaused,
			})

			this.progress.endTime = Date.now()
			this.setStatus("indexed")

			await updateFolder(this.folder.id, {
				lastIndexedAt: Date.now(),
				fileCount: result.stats.processed,
				errorCount: this.errors.length,
				lastIndexedWithLsp: this.lspEnricher !== null,
				lastIndexedWithModel: this.modelId,
			})

			console.log(`[${this.folder.name}] Re-enrichment complete: ${result.stats.processed} files processed`)
			return result
		} catch (error) {
			console.error(`Error re-enriching folder ${this.folder.path}:`, error)
			this.addError("", error instanceof Error ? error.message : String(error))
			this.setStatus("error")

			await updateFolder(this.folder.id, {
				lastError: error instanceof Error ? error.message : String(error),
				errorCount: this.errors.length,
			})

			throw error
		}
	}

	async dispose(): Promise<void> {
		await this.stopWatching()
		this.embeddingCache.close()

		// Shutdown LSP components
		if (this.lspEnricher) {
			await this.lspEnricher.shutdown()
			this.lspEnricher = null
		}
		if (this.lspCache) {
			this.lspCache.close()
			this.lspCache = null
		}
		this.lspServerManager = null
	}
}

/**
 * Create a new folder ID
 */
export function generateFolderId(): string {
	return uuidv4()
}

/**
 * Create folder name from path
 */
export function getFolderNameFromPath(folderPath: string): string {
	return path.basename(folderPath) || folderPath
}
