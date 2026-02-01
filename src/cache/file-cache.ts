import * as fs from "fs/promises"
import * as path from "path"
import type { ICacheManager, FileCache } from "../types/index.js"
import { getCacheFilePath } from "../config/store.js"

/**
 * File-based cache manager for a single folder
 */
export class FileCacheManager implements ICacheManager {
	private cachePath: string
	private fileHashes: FileCache = {}
	private saveTimer: ReturnType<typeof setTimeout> | null = null
	private readonly SAVE_DEBOUNCE_MS = 1500

	constructor(folderId: string) {
		this.cachePath = getCacheFilePath(folderId)
	}

	async initialize(): Promise<void> {
		try {
			const content = await fs.readFile(this.cachePath, "utf-8")
			this.fileHashes = JSON.parse(content) as FileCache
		} catch {
			this.fileHashes = {}
		}
	}

	getHash(filePath: string): string | undefined {
		return this.fileHashes[filePath]
	}

	async updateHash(filePath: string, hash: string): Promise<void> {
		this.fileHashes[filePath] = hash
		this._scheduleSave()
	}

	async deleteHash(filePath: string): Promise<void> {
		delete this.fileHashes[filePath]
		this._scheduleSave()
	}

	getAllHashes(): Record<string, string> {
		return { ...this.fileHashes }
	}

	getFileCount(): number {
		return Object.keys(this.fileHashes).length
	}

	async clearCacheFile(): Promise<void> {
		this.fileHashes = {}
		await this._performSave()
	}

	private _scheduleSave(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer)
		}
		this.saveTimer = setTimeout(() => this._performSave(), this.SAVE_DEBOUNCE_MS)
	}

	private async _performSave(): Promise<void> {
		try {
			const dir = path.dirname(this.cachePath)
			await fs.mkdir(dir, { recursive: true })

			const tempPath = `${this.cachePath}.tmp`
			await fs.writeFile(tempPath, JSON.stringify(this.fileHashes, null, 2), "utf-8")
			await fs.rename(tempPath, this.cachePath)
		} catch (error) {
			console.error("Failed to save cache:", error)
		}
	}

	async flush(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer)
			this.saveTimer = null
		}
		await this._performSave()
	}
}
