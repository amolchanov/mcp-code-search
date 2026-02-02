import sqlite3 from "sqlite3"
import { open, Database } from "sqlite"
import * as path from "path"
import * as fs from "fs"
import { getDataDir } from "../config/store.js"
import type { LSPEnrichmentData } from "./types.js"

const DB_FILE = "lsp-cache.db"

/**
 * SQLite-based cache for LSP enrichment results using async sqlite3
 * Stores enrichment data by segment hash to avoid redundant LSP queries
 * All operations are async and non-blocking.
 */
export class LSPCache {
	private db: Database | null = null

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

		this.db = await open({
			filename: dbPath,
			driver: sqlite3.Database,
		})

		// Enable WAL mode for better concurrent performance
		await this.db.run("PRAGMA journal_mode = WAL")

		// Create table
		await this.db.exec(`
			CREATE TABLE IF NOT EXISTS lsp_enrichments (
				segment_hash TEXT PRIMARY KEY,
				enrichment_json TEXT NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
			)
		`)
	}

	/**
	 * Get cached enrichment by segment hash
	 */
	async getEnrichment(segmentHash: string): Promise<LSPEnrichmentData | null> {
		if (!this.db) return null

		const row = await this.db.get<{ enrichment_json: string }>(
			"SELECT enrichment_json FROM lsp_enrichments WHERE segment_hash = ?",
			segmentHash
		)

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
	async getEnrichments(segmentHashes: string[]): Promise<Map<string, LSPEnrichmentData>> {
		const result = new Map<string, LSPEnrichmentData>()
		if (!this.db || segmentHashes.length === 0) return result

		// Build dynamic query for batch lookup
		const placeholders = segmentHashes.map(() => "?").join(",")
		const rows = await this.db.all<Array<{ segment_hash: string; enrichment_json: string }>>(
			`SELECT segment_hash, enrichment_json FROM lsp_enrichments
			 WHERE segment_hash IN (${placeholders})`,
			...segmentHashes
		)

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
	async setEnrichment(segmentHash: string, enrichment: LSPEnrichmentData): Promise<void> {
		if (!this.db) return

		const json = JSON.stringify(enrichment)
		await this.db.run(
			"INSERT OR REPLACE INTO lsp_enrichments (segment_hash, enrichment_json) VALUES (?, ?)",
			segmentHash,
			json
		)
	}

	/**
	 * Store multiple enrichments at once (uses transaction for efficiency)
	 */
	async setEnrichments(
		entries: Array<{ segmentHash: string; enrichment: LSPEnrichmentData }>
	): Promise<void> {
		if (!this.db || entries.length === 0) return

		await this.db.run("BEGIN TRANSACTION")
		try {
			for (const entry of entries) {
				const json = JSON.stringify(entry.enrichment)
				await this.db.run(
					"INSERT OR REPLACE INTO lsp_enrichments (segment_hash, enrichment_json) VALUES (?, ?)",
					entry.segmentHash,
					json
				)
			}
			await this.db.run("COMMIT")
		} catch (error) {
			await this.db.run("ROLLBACK")
			throw error
		}
	}

	/**
	 * Delete enrichments for specific segment hashes
	 */
	async deleteEnrichments(segmentHashes: string[]): Promise<void> {
		if (!this.db || segmentHashes.length === 0) return

		const placeholders = segmentHashes.map(() => "?").join(",")
		await this.db.run(
			`DELETE FROM lsp_enrichments WHERE segment_hash IN (${placeholders})`,
			...segmentHashes
		)
	}

	/**
	 * Clear all enrichments
	 */
	async clearAll(): Promise<void> {
		if (!this.db) return
		await this.db.run("DELETE FROM lsp_enrichments")
	}

	/**
	 * Get cache statistics
	 */
	async getStats(): Promise<{ totalEntries: number; sizeBytes: number }> {
		if (!this.db) return { totalEntries: 0, sizeBytes: 0 }

		const total = await this.db.get<{ count: number }>(
			"SELECT COUNT(*) as count FROM lsp_enrichments"
		)

		const dbPath = path.join(getDataDir(), DB_FILE)
		let sizeBytes = 0
		try {
			sizeBytes = fs.statSync(dbPath).size
		} catch {
			// File may not exist
		}

		return {
			totalEntries: total?.count || 0,
			sizeBytes,
		}
	}

	/**
	 * Close the database connection
	 */
	async close(): Promise<void> {
		if (this.db) {
			await this.db.close()
			this.db = null
		}
	}
}
