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

const QUERIES_DIR = "queries"
const MAX_QUERIES_PER_FOLDER = 100
const DEFAULT_RETENTION_DAYS = 1

class QueryLogger {
	private getQueriesDir(): string {
		return path.join(getDataDir(), QUERIES_DIR)
	}

	private getLogFileName(date: Date): string {
		const dateStr = date.toISOString().split("T")[0] // YYYY-MM-DD
		return `queries-${dateStr}.jsonl`
	}

	private getLogFilePath(date: Date): string {
		return path.join(this.getQueriesDir(), this.getLogFileName(date))
	}

	private async ensureQueriesDir(): Promise<void> {
		try {
			await fs.mkdir(this.getQueriesDir(), { recursive: true })
		} catch {
			// Directory may already exist
		}
	}

	/**
	 * Log a query to the current day's log file (append mode)
	 */
	async logQuery(entry: Omit<QueryLogEntry, "id">): Promise<void> {
		await this.ensureQueriesDir()

		const logEntry: QueryLogEntry = {
			...entry,
			id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
		}

		const filePath = this.getLogFilePath(new Date())
		const line = JSON.stringify(logEntry) + "\n"

		// Append to file (creates if doesn't exist)
		await fs.appendFile(filePath, line, "utf-8")
	}

	/**
	 * Read all queries from recent log files
	 */
	private async readAllQueries(retentionDays: number = DEFAULT_RETENTION_DAYS): Promise<QueryLogEntry[]> {
		await this.ensureQueriesDir()

		const queries: QueryLogEntry[] = []
		const now = new Date()
		const cutoffTime = now.getTime() - retentionDays * 24 * 60 * 60 * 1000

		try {
			const files = await fs.readdir(this.getQueriesDir())
			const logFiles = files.filter((f) => f.startsWith("queries-") && f.endsWith(".jsonl")).sort().reverse() // Most recent first

			for (const file of logFiles) {
				// Extract date from filename
				const dateMatch = file.match(/queries-(\d{4}-\d{2}-\d{2})\.jsonl/)
				if (!dateMatch) continue

				const fileDate = new Date(dateMatch[1])
				if (fileDate.getTime() < cutoffTime) {
					// Skip files older than retention period
					continue
				}

				const filePath = path.join(this.getQueriesDir(), file)
				try {
					const content = await fs.readFile(filePath, "utf-8")
					const lines = content.trim().split("\n").filter(Boolean)

					for (const line of lines) {
						try {
							const entry = JSON.parse(line) as QueryLogEntry
							queries.push(entry)
						} catch {
							// Skip malformed lines
						}
					}
				} catch {
					// Skip unreadable files
				}
			}
		} catch {
			// Directory doesn't exist yet
		}

		// Sort by timestamp descending
		queries.sort((a, b) => b.timestamp - a.timestamp)
		return queries
	}

	/**
	 * Get queries, optionally filtered by folder
	 * Always reads from disk to see updates from other instances
	 */
	async getQueries(folderId?: string, limit: number = 50): Promise<QueryLogEntry[]> {
		const allQueries = await this.readAllQueries()

		let filtered = allQueries
		if (folderId) {
			filtered = allQueries.filter((q) => q.folderId === folderId)
		}

		return filtered.slice(0, limit)
	}

	/**
	 * Get queries grouped by folder
	 * Always reads from disk to see updates from other instances
	 */
	async getQueriesByFolder(): Promise<Map<string | null, QueryLogEntry[]>> {
		const allQueries = await this.readAllQueries()

		const byFolder = new Map<string | null, QueryLogEntry[]>()

		for (const q of allQueries) {
			const key = q.folderId
			if (!byFolder.has(key)) {
				byFolder.set(key, [])
			}
			byFolder.get(key)!.push(q)
		}

		// Trim each folder to max queries
		for (const [key, entries] of byFolder) {
			if (entries.length > MAX_QUERIES_PER_FOLDER) {
				byFolder.set(key, entries.slice(0, MAX_QUERIES_PER_FOLDER))
			}
		}

		return byFolder
	}

	/**
	 * Clear queries for a specific folder or all queries
	 */
	async clearQueries(folderId?: string): Promise<void> {
		if (!folderId) {
			// Clear all - delete all log files
			try {
				const files = await fs.readdir(this.getQueriesDir())
				for (const file of files) {
					if (file.startsWith("queries-") && file.endsWith(".jsonl")) {
						await fs.unlink(path.join(this.getQueriesDir(), file))
					}
				}
			} catch {
				// Directory doesn't exist
			}
		} else {
			// Clear specific folder - rewrite all files without that folder's queries
			const allQueries = await this.readAllQueries()
			const filtered = allQueries.filter((q) => q.folderId !== folderId)

			// Delete all existing files
			try {
				const files = await fs.readdir(this.getQueriesDir())
				for (const file of files) {
					if (file.startsWith("queries-") && file.endsWith(".jsonl")) {
						await fs.unlink(path.join(this.getQueriesDir(), file))
					}
				}
			} catch {
				// Directory doesn't exist
			}

			// Rewrite filtered queries grouped by date
			const byDate = new Map<string, QueryLogEntry[]>()
			for (const q of filtered) {
				const dateStr = new Date(q.timestamp).toISOString().split("T")[0]
				if (!byDate.has(dateStr)) {
					byDate.set(dateStr, [])
				}
				byDate.get(dateStr)!.push(q)
			}

			await this.ensureQueriesDir()
			for (const [dateStr, entries] of byDate) {
				const filePath = path.join(this.getQueriesDir(), `queries-${dateStr}.jsonl`)
				const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
				await fs.writeFile(filePath, content, "utf-8")
			}
		}
	}

	/**
	 * Clean up old log files beyond retention period
	 */
	async cleanupOldLogs(retentionDays: number = DEFAULT_RETENTION_DAYS): Promise<number> {
		const now = new Date()
		const cutoffTime = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
		let deletedCount = 0

		try {
			const files = await fs.readdir(this.getQueriesDir())

			for (const file of files) {
				if (!file.startsWith("queries-") || !file.endsWith(".jsonl")) continue

				const dateMatch = file.match(/queries-(\d{4}-\d{2}-\d{2})\.jsonl/)
				if (!dateMatch) continue

				const fileDate = new Date(dateMatch[1])
				if (fileDate.getTime() < cutoffTime) {
					await fs.unlink(path.join(this.getQueriesDir(), file))
					deletedCount++
				}
			}
		} catch {
			// Directory doesn't exist
		}

		return deletedCount
	}

	/**
	 * Get log file stats for admin UI
	 */
	async getLogStats(): Promise<{ fileCount: number; totalQueries: number; oldestDate: string | null; newestDate: string | null }> {
		try {
			const files = await fs.readdir(this.getQueriesDir())
			const logFiles = files.filter((f) => f.startsWith("queries-") && f.endsWith(".jsonl")).sort()

			if (logFiles.length === 0) {
				return { fileCount: 0, totalQueries: 0, oldestDate: null, newestDate: null }
			}

			const allQueries = await this.readAllQueries(365) // Read up to a year for stats
			const oldestMatch = logFiles[0].match(/queries-(\d{4}-\d{2}-\d{2})/)
			const newestMatch = logFiles[logFiles.length - 1].match(/queries-(\d{4}-\d{2}-\d{2})/)

			return {
				fileCount: logFiles.length,
				totalQueries: allQueries.length,
				oldestDate: oldestMatch ? oldestMatch[1] : null,
				newestDate: newestMatch ? newestMatch[1] : null,
			}
		} catch {
			return { fileCount: 0, totalQueries: 0, oldestDate: null, newestDate: null }
		}
	}
}

// Singleton instance
export const queryLogger = new QueryLogger()
