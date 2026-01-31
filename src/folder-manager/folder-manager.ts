import * as path from "path"
import type { IEmbedder, IVectorStore, IndexedFolder, FolderProgress, IndexingError, FolderStatus } from "../types/index.js"
import { FolderIndexer, generateFolderId, getFolderNameFromPath } from "./folder-indexer.js"
import {
	addFolder,
	removeFolder,
	getAllFolders,
	updateFolder,
	getFolder,
	getFolderByPath,
} from "../config/store.js"
import { isDirectory } from "../utils/fs.js"

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
		private readonly callbacks?: FolderManagerCallbacks
	) {}

	async initialize(): Promise<void> {
		if (this.isInitialized) return

		// Load existing folders from config
		const folders = await getAllFolders()

		for (const folder of folders) {
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
			})
			await indexer.initialize()
			this.indexers.set(folder.id, indexer)
		}

		this.isInitialized = true
	}

	async addFolder(folderPath: string, startIndexing: boolean = true): Promise<IndexedFolder> {
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

		const folder: IndexedFolder = {
			id: generateFolderId(),
			path: normalizedPath,
			name: getFolderNameFromPath(normalizedPath),
			status: "pending",
			addedAt: Date.now(),
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
		})
		await indexer.initialize()
		this.indexers.set(folder.id, indexer)

		this.callbacks?.onFolderAdded?.(folder)

		if (startIndexing) {
			// Start indexing in the background
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

	async stopIndexing(folderId: string): Promise<void> {
		const indexer = this.indexers.get(folderId)
		if (indexer) {
			await indexer.stopWatching()
		}
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
}
