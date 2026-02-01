import Database from "better-sqlite3"
import * as path from "path"
import * as fs from "fs"
import { getDataDir } from "../config/store.js"

const DB_FILE = "embedding-cache.db"

/**
 * SQLite-based cache for embeddings
 * Stores embeddings by segment hash + model ID to allow reuse across indexing runs
 */
export class EmbeddingCache {
	private db: Database.Database | null = null
	private getStmt: Database.Statement | null = null
	private insertStmt: Database.Statement | null = null
	private getManyStmt: Database.Statement | null = null

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

		this.db = new Database(dbPath)

		// Enable WAL mode for better concurrent performance
		this.db.pragma("journal_mode = WAL")

		// Create table
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS embeddings (
				segment_hash TEXT NOT NULL,
				model_id TEXT NOT NULL,
				embedding BLOB NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				PRIMARY KEY (segment_hash, model_id)
			)
		`)

		// Create index for faster lookups
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_embeddings_model
			ON embeddings(model_id)
		`)

		// Prepare statements for reuse
		this.getStmt = this.db.prepare(
			"SELECT embedding FROM embeddings WHERE segment_hash = ? AND model_id = ?"
		)

		this.insertStmt = this.db.prepare(
			"INSERT OR REPLACE INTO embeddings (segment_hash, model_id, embedding) VALUES (?, ?, ?)"
		)
	}

	/**
	 * Get a cached embedding by segment hash
	 */
	getEmbedding(segmentHash: string): number[] | null {
		if (!this.db || !this.getStmt) return null

		const row = this.getStmt.get(segmentHash, this.modelId) as { embedding: Buffer } | undefined
		if (!row) return null

		return this.deserializeEmbedding(row.embedding)
	}

	/**
	 * Get multiple cached embeddings at once
	 * Returns a map of segmentHash -> embedding (only for cache hits)
	 */
	getEmbeddings(segmentHashes: string[]): Map<string, number[]> {
		const result = new Map<string, number[]>()
		if (!this.db || segmentHashes.length === 0) return result

		// Build dynamic query for batch lookup
		const placeholders = segmentHashes.map(() => "?").join(",")
		const stmt = this.db.prepare(
			`SELECT segment_hash, embedding FROM embeddings
			 WHERE segment_hash IN (${placeholders}) AND model_id = ?`
		)

		const rows = stmt.all(...segmentHashes, this.modelId) as { segment_hash: string; embedding: Buffer }[]

		for (const row of rows) {
			result.set(row.segment_hash, this.deserializeEmbedding(row.embedding))
		}

		return result
	}

	/**
	 * Store an embedding in the cache
	 */
	setEmbedding(segmentHash: string, embedding: number[]): void {
		if (!this.db || !this.insertStmt) return

		const buffer = this.serializeEmbedding(embedding)
		this.insertStmt.run(segmentHash, this.modelId, buffer)
	}

	/**
	 * Store multiple embeddings at once (transactional)
	 */
	setEmbeddings(entries: Array<{ segmentHash: string; embedding: number[] }>): void {
		if (!this.db || !this.insertStmt || entries.length === 0) return

		const transaction = this.db.transaction(() => {
			for (const entry of entries) {
				const buffer = this.serializeEmbedding(entry.embedding)
				this.insertStmt!.run(entry.segmentHash, this.modelId, buffer)
			}
		})

		transaction()
	}

	/**
	 * Delete embeddings for specific segment hashes
	 */
	deleteEmbeddings(segmentHashes: string[]): void {
		if (!this.db || segmentHashes.length === 0) return

		const placeholders = segmentHashes.map(() => "?").join(",")
		const stmt = this.db.prepare(
			`DELETE FROM embeddings WHERE segment_hash IN (${placeholders}) AND model_id = ?`
		)
		stmt.run(...segmentHashes, this.modelId)
	}

	/**
	 * Clear all embeddings for the current model
	 */
	clearForModel(): void {
		if (!this.db) return
		this.db.prepare("DELETE FROM embeddings WHERE model_id = ?").run(this.modelId)
	}

	/**
	 * Clear all embeddings
	 */
	clearAll(): void {
		if (!this.db) return
		this.db.prepare("DELETE FROM embeddings").run()
	}

	/**
	 * Get cache statistics
	 */
	getStats(): { totalEntries: number; modelEntries: number; sizeBytes: number } {
		if (!this.db) return { totalEntries: 0, modelEntries: 0, sizeBytes: 0 }

		const total = this.db.prepare("SELECT COUNT(*) as count FROM embeddings").get() as { count: number }
		const model = this.db
			.prepare("SELECT COUNT(*) as count FROM embeddings WHERE model_id = ?")
			.get(this.modelId) as { count: number }

		const dbPath = path.join(getDataDir(), DB_FILE)
		let sizeBytes = 0
		try {
			sizeBytes = fs.statSync(dbPath).size
		} catch {
			// File may not exist
		}

		return {
			totalEntries: total.count,
			modelEntries: model.count,
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
