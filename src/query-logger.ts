import * as fs from "fs/promises"
import * as path from "path"
import { getDataDir } from "./config/store.js"

export interface QueryResultEntry {
	filePath: string
	startLine: number
	endLine: number
	score: number
	codeSnippet?: string
}

export interface QueryLogEntry {
	id: string
	query: string
	folderId: string | null
	folderPath: string | null
	timestamp: number
	resultsCount: number
	results?: QueryResultEntry[]
	minScore?: number
	maxResults?: number
	executionTimeMs: number
}

const QUERIES_FILE = "queries.json"
const MAX_QUERIES_PER_FOLDER = 100

class QueryLogger {
	private queries: QueryLogEntry[] = []
	private initialized = false

	private getFilePath(): string {
		return path.join(getDataDir(), QUERIES_FILE)
	}

	async initialize(): Promise<void> {
		if (this.initialized) return

		try {
			const content = await fs.readFile(this.getFilePath(), "utf-8")
			this.queries = JSON.parse(content) as QueryLogEntry[]
		} catch {
			this.queries = []
		}
		this.initialized = true
	}

	async logQuery(entry: Omit<QueryLogEntry, "id">): Promise<void> {
		await this.initialize()

		const logEntry: QueryLogEntry = {
			...entry,
			id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
		}

		this.queries.push(logEntry)

		// Trim old queries to prevent unbounded growth
		// Keep most recent MAX_QUERIES_PER_FOLDER per folder + global queries
		this.trimQueries()

		await this.save()
	}

	private trimQueries(): void {
		// Group by folderId (null for global queries)
		const byFolder = new Map<string | null, QueryLogEntry[]>()

		for (const q of this.queries) {
			const key = q.folderId
			if (!byFolder.has(key)) {
				byFolder.set(key, [])
			}
			byFolder.get(key)!.push(q)
		}

		// Keep only the most recent MAX_QUERIES_PER_FOLDER per folder
		const trimmed: QueryLogEntry[] = []
		for (const [, entries] of byFolder) {
			entries.sort((a, b) => b.timestamp - a.timestamp)
			trimmed.push(...entries.slice(0, MAX_QUERIES_PER_FOLDER))
		}

		// Sort by timestamp descending
		trimmed.sort((a, b) => b.timestamp - a.timestamp)
		this.queries = trimmed
	}

	private async save(): Promise<void> {
		const filePath = this.getFilePath()
		const tempPath = `${filePath}.tmp`
		await fs.writeFile(tempPath, JSON.stringify(this.queries, null, 2), "utf-8")
		await fs.rename(tempPath, filePath)
	}

	async getQueries(folderId?: string, limit: number = 50): Promise<QueryLogEntry[]> {
		await this.initialize()

		let filtered = this.queries
		if (folderId) {
			filtered = this.queries.filter((q) => q.folderId === folderId)
		}

		return filtered.slice(0, limit)
	}

	async getQueriesByFolder(): Promise<Map<string | null, QueryLogEntry[]>> {
		await this.initialize()

		const byFolder = new Map<string | null, QueryLogEntry[]>()

		for (const q of this.queries) {
			const key = q.folderId
			if (!byFolder.has(key)) {
				byFolder.set(key, [])
			}
			byFolder.get(key)!.push(q)
		}

		// Sort each folder's queries by timestamp descending
		for (const [, entries] of byFolder) {
			entries.sort((a, b) => b.timestamp - a.timestamp)
		}

		return byFolder
	}

	async clearQueries(folderId?: string): Promise<void> {
		await this.initialize()

		if (folderId) {
			this.queries = this.queries.filter((q) => q.folderId !== folderId)
		} else {
			this.queries = []
		}

		await this.save()
	}
}

// Singleton instance
export const queryLogger = new QueryLogger()
