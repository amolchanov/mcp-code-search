import sqlite3 from "sqlite3"
import { open, Database } from "sqlite"
import * as path from "path"
import * as fs from "fs"
import { getDataDir } from "../config/store.js"

const DB_FILE = "embedding-cache.db"

/**
 * SQLite-based cache for embeddings using async sqlite3
 * Stores embeddings by segment hash + model ID to allow reuse across indexing runs
 * All operations are async and non-blocking.
 */
export class EmbeddingCache {
	private db: Database | null = null

	constructor(private readonly modelId: string) {}

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
			CREATE TABLE IF NOT EXISTS embeddings (
				segment_hash TEXT NOT NULL,
				model_id TEXT NOT NULL,
				embedding BLOB NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
				PRIMARY KEY (segment_hash, model_id)
			)
		`)

		// Create index for faster lookups
		await this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_embeddings_model
			ON embeddings(model_id)
		`)
	}

	/**
	 * Get a cached embedding by segment hash
	 */
	async getEmbedding(segmentHash: string): Promise<number[] | null> {
		if (!this.db) return null

		const row = await this.db.get<{ embedding: Buffer }>(
			"SELECT embedding FROM embeddings WHERE segment_hash = ? AND model_id = ?",
			segmentHash,
			this.modelId
		)

		if (!row) return null
		return this.deserializeEmbedding(row.embedding)
	}

	/**
	 * Get multiple cached embeddings at once
	 * Returns a map of segmentHash -> embedding (only for cache hits)
	 */
	async getEmbeddings(segmentHashes: string[]): Promise<Map<string, number[]>> {
		const result = new Map<string, number[]>()
		if (!this.db || segmentHashes.length === 0) return result

		// Build dynamic query for batch lookup
		const placeholders = segmentHashes.map(() => "?").join(",")
		const rows = await this.db.all<Array<{ segment_hash: string; embedding: Buffer }>>(
			`SELECT segment_hash, embedding FROM embeddings
			 WHERE segment_hash IN (${placeholders}) AND model_id = ?`,
			...segmentHashes,
			this.modelId
		)

		for (const row of rows) {
			result.set(row.segment_hash, this.deserializeEmbedding(row.embedding))
		}

		return result
	}

	/**
	 * Store an embedding in the cache
	 */
	async setEmbedding(segmentHash: string, embedding: number[]): Promise<void> {
		if (!this.db) return

		const buffer = this.serializeEmbedding(embedding)
		await this.db.run(
			"INSERT OR REPLACE INTO embeddings (segment_hash, model_id, embedding) VALUES (?, ?, ?)",
			segmentHash,
			this.modelId,
			buffer
		)
	}

	/**
	 * Store multiple embeddings at once (uses transaction for efficiency)
	 */
	async setEmbeddings(entries: Array<{ segmentHash: string; embedding: number[] }>): Promise<void> {
		if (!this.db || entries.length === 0) return

		await this.db.run("BEGIN TRANSACTION")
		try {
			for (const entry of entries) {
				const buffer = this.serializeEmbedding(entry.embedding)
				await this.db.run(
					"INSERT OR REPLACE INTO embeddings (segment_hash, model_id, embedding) VALUES (?, ?, ?)",
					entry.segmentHash,
					this.modelId,
					buffer
				)
			}
			await this.db.run("COMMIT")
		} catch (error) {
			await this.db.run("ROLLBACK")
			throw error
		}
	}

	/**
	 * Delete embeddings for specific segment hashes
	 */
	async deleteEmbeddings(segmentHashes: string[]): Promise<void> {
		if (!this.db || segmentHashes.length === 0) return

		const placeholders = segmentHashes.map(() => "?").join(",")
		await this.db.run(
			`DELETE FROM embeddings WHERE segment_hash IN (${placeholders}) AND model_id = ?`,
			...segmentHashes,
			this.modelId
		)
	}

	/**
	 * Clear all embeddings for the current model
	 */
	async clearForModel(): Promise<void> {
		if (!this.db) return
		await this.db.run("DELETE FROM embeddings WHERE model_id = ?", this.modelId)
	}

	/**
	 * Clear all embeddings
	 */
	async clearAll(): Promise<void> {
		if (!this.db) return
		await this.db.run("DELETE FROM embeddings")
	}

	/**
	 * Get cache statistics
	 */
	async getStats(): Promise<{ totalEntries: number; modelEntries: number; sizeBytes: number }> {
		if (!this.db) return { totalEntries: 0, modelEntries: 0, sizeBytes: 0 }

		const total = await this.db.get<{ count: number }>("SELECT COUNT(*) as count FROM embeddings")
		const model = await this.db.get<{ count: number }>(
			"SELECT COUNT(*) as count FROM embeddings WHERE model_id = ?",
			this.modelId
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
			modelEntries: model?.count || 0,
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

	/**
	 * Serialize embedding array to buffer (Float32Array for efficiency)
	 */
	private serializeEmbedding(embedding: number[]): Buffer {
		const float32 = new Float32Array(embedding)
		return Buffer.from(float32.buffer)
	}

	/**
	 * Deserialize buffer back to embedding array
	 */
	private deserializeEmbedding(buffer: Buffer): number[] {
		const float32 = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4)
		return Array.from(float32)
	}
}
