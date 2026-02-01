import Database from "better-sqlite3"
import * as path from "path"
import * as fs from "fs"
import { getDataDir } from "../config/store.js"
import type { LSPEnrichmentData } from "./types.js"

const DB_FILE = "lsp-cache.db"

/**
 * SQLite-based cache for LSP enrichment results
 * Stores enrichment data by segment hash to avoid redundant LSP queries
 */
export class LSPCache {
	private db: Database.Database | null = null
	private getStmt: Database.Statement | null = null
	private insertStmt: Database.Statement | null = null

	/**
	 * Initialize the database and create tables if needed
	 */
	async initialize(): Promise<void> {
		const dbPath = path.join(getDataDir(), DB_FILE)

		// Ensure data directory exists
		const dir = path.dirname(dbPath)
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true })
		}

		this.db = new Database(dbPath)

		// Enable WAL mode for better concurrent performance
		this.db.pragma("journal_mode = WAL")

		// Create table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS lsp_enrichments (
				segment_hash TEXT PRIMARY KEY,
				enrichment_json TEXT NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (unixepoch())
			)
		`)

		// Prepare statements for reuse
		this.getStmt = this.db.prepare(
			"SELECT enrichment_json FROM lsp_enrichments WHERE segment_hash = ?"
		)

		this.insertStmt = this.db.prepare(
			"INSERT OR REPLACE INTO lsp_enrichments (segment_hash, enrichment_json) VALUES (?, ?)"
		)
	}

	/**
	 * Get cached enrichment by segment hash
	 */
	getEnrichment(segmentHash: string): LSPEnrichmentData | null {
		if (!this.db || !this.getStmt) return null

		const row = this.getStmt.get(segmentHash) as { enrichment_json: string } | undefined
		if (!row) return null

		try {
			return JSON.parse(row.enrichment_json) as LSPEnrichmentData
		} catch {
			return null
		}
	}

	/**
	 * Get multiple cached enrichments at once
	 * Returns a map of segmentHash -> enrichment (only for cache hits)
	 */
	getEnrichments(segmentHashes: string[]): Map<string, LSPEnrichmentData> {
		const result = new Map<string, LSPEnrichmentData>()
		if (!this.db || segmentHashes.length === 0) return result

		// Build dynamic query for batch lookup
		const placeholders = segmentHashes.map(() => "?").join(",")
		const stmt = this.db.prepare(
			`SELECT segment_hash, enrichment_json FROM lsp_enrichments
			 WHERE segment_hash IN (${placeholders})`
		)

		const rows = stmt.all(...segmentHashes) as Array<{
			segment_hash: string
			enrichment_json: string
		}>

		for (const row of rows) {
			try {
				const enrichment = JSON.parse(row.enrichment_json) as LSPEnrichmentData
				result.set(row.segment_hash, enrichment)
			} catch {
				// Skip invalid entries
			}
		}

		return result
	}

	/**
	 * Store an enrichment in the cache
	 */
	setEnrichment(segmentHash: string, enrichment: LSPEnrichmentData): void {
		if (!this.db || !this.insertStmt) return

		const json = JSON.stringify(enrichment)
		this.insertStmt.run(segmentHash, json)
	}

	/**
	 * Store multiple enrichments at once (transactional)
	 */
	setEnrichments(
		entries: Array<{ segmentHash: string; enrichment: LSPEnrichmentData }>
	): void {
		if (!this.db || !this.insertStmt || entries.length === 0) return

		const transaction = this.db.transaction(() => {
			for (const entry of entries) {
				const json = JSON.stringify(entry.enrichment)
				this.insertStmt!.run(entry.segmentHash, json)
			}
		})

		transaction()
	}

	/**
	 * Delete enrichments for specific segment hashes
	 */
	deleteEnrichments(segmentHashes: string[]): void {
		if (!this.db || segmentHashes.length === 0) return

		const placeholders = segmentHashes.map(() => "?").join(",")
		const stmt = this.db.prepare(
			`DELETE FROM lsp_enrichments WHERE segment_hash IN (${placeholders})`
		)
		stmt.run(...segmentHashes)
	}

	/**
	 * Clear all enrichments
	 */
	clearAll(): void {
		if (!this.db) return
		this.db.prepare("DELETE FROM lsp_enrichments").run()
	}

	/**
	 * Get cache statistics
	 */
	getStats(): { totalEntries: number; sizeBytes: number } {
		if (!this.db) return { totalEntries: 0, sizeBytes: 0 }

		const total = this.db.prepare("SELECT COUNT(*) as count FROM lsp_enrichments").get() as {
			count: number
		}

		const dbPath = path.join(getDataDir(), DB_FILE)
		let sizeBytes = 0
		try {
			sizeBytes = fs.statSync(dbPath).size
		} catch {
			// File may not exist
		}

		return {
			totalEntries: total.count,
			sizeBytes,
		}
	}

	/**
	 * Close the database connection
	 */
	close(): void {
		if (this.db) {
			this.db.close()
			this.db = null
			this.getStmt = null
			this.insertStmt = null
		}
	}
}
