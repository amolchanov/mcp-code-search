import chokidar from "chokidar"
import * as path from "path"
import { createHash } from "crypto"
import { v5 as uuidv5 } from "uuid"
import type { IEmbedder, IVectorStore, ICodeParser, ICacheManager, CodeBlock } from "../types/index.js"
import { scannerExtensions } from "../parser/supported-extensions.js"
import { createIgnoreFromGitignore, isPathInIgnoredDirectory } from "../utils/ignore.js"
import { getRelativePath, getFileSize, readFileContent, fileExists } from "../utils/fs.js"
import type { Ignore } from "ignore"
import type { EmbeddingCache } from "../cache/embedding-cache.js"
import type { ILSPEnricher, EnrichedCodeBlock } from "../lsp/types.js"

const QDRANT_CODE_BLOCK_NAMESPACE = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024 // 1MB
const BATCH_DEBOUNCE_DELAY_MS = 500
const FILE_PROCESSING_CONCURRENCY = 10
const BATCH_SEGMENT_THRESHOLD = 60
const MAX_BATCH_RETRIES = 3
const INITIAL_RETRY_DELAY_MS = 500

export interface FileWatcherCallbacks {
	onBatchStart?: (files: string[]) => void
	onBatchProgress?: (processed: number, total: number, currentFile?: string) => void
	onBatchComplete?: (results: { success: number; errors: number }) => void
	onError?: (error: Error) => void
}

export interface FileWatcherOptions {
	pollInterval?: number
}

type EventType = "add" | "change" | "unlink"

interface FileEvent {
	path: string
	type: EventType
}

/**
 * File watcher using chokidar for a folder
 */
export class FileWatcher {
	private watcher: chokidar.FSWatcher | null = null
	private ignoreInstance: Ignore | null = null
	private accumulatedEvents: Map<string, FileEvent> = new Map()
	private batchTimer: ReturnType<typeof setTimeout> | null = null
	private isProcessing = false
	private readonly allowedExtensions: string[]

	constructor(
		private readonly folderId: string,
		private readonly folderPath: string,
		private readonly embedder: IEmbedder,
		private readonly vectorStore: IVectorStore,
		private readonly codeParser: ICodeParser,
		private readonly cacheManager: ICacheManager,
		private readonly callbacks?: FileWatcherCallbacks,
		private readonly options?: FileWatcherOptions,
		private readonly embeddingCache?: EmbeddingCache,
		private readonly lspEnricher?: ILSPEnricher,
		includeExtensions?: string[]
	) {
		// Use provided extensions or default to all supported
		this.allowedExtensions = includeExtensions || scannerExtensions
	}

	async initialize(): Promise<void> {
		this.ignoreInstance = await createIgnoreFromGitignore(this.folderPath)

		// Build glob pattern for allowed extensions
		const extensionPattern = this.allowedExtensions.map((ext) => ext.slice(1)).join(",")
		const globPattern = `**/*.{${extensionPattern}}`

		// Use ignore instance to filter paths in chokidar
		const ignoredFn = (filePath: string): boolean => {
			// Get relative path from folder
			const relativePath = path.relative(this.folderPath, filePath).replace(/\\/g, "/")
			if (!relativePath) return false

			// Check against gitignore patterns
			if (this.ignoreInstance?.ignores(relativePath)) {
				return true
			}

			// Check against always-ignored directories
			return isPathInIgnoredDirectory(relativePath)
		}

		const pollInterval = this.options?.pollInterval ?? 100

		this.watcher = chokidar.watch(globPattern, {
			cwd: this.folderPath,
			ignored: ignoredFn,
			persistent: true,
			ignoreInitial: true,
			awaitWriteFinish: {
				stabilityThreshold: 300,
				pollInterval,
			},
		})

		this.watcher.on("add", (relativePath) => this.handleFileEvent(relativePath, "add"))
		this.watcher.on("change", (relativePath) => this.handleFileEvent(relativePath, "change"))
		this.watcher.on("unlink", (relativePath) => this.handleFileEvent(relativePath, "unlink"))

		this.watcher.on("error", (error) => {
			console.error("File watcher error:", error)
			this.callbacks?.onError?.(error)
		})
	}

	private handleFileEvent(relativePath: string, type: EventType): void {
		const fullPath = path.join(this.folderPath, relativePath)

		// Check if should be ignored
		if (this.ignoreInstance?.ignores(relativePath) || isPathInIgnoredDirectory(relativePath)) {
			return
		}

		this.accumulatedEvents.set(fullPath, { path: fullPath, type })
		this.scheduleBatchProcessing()
	}

	private scheduleBatchProcessing(): void {
		if (this.batchTimer) {
			clearTimeout(this.batchTimer)
		}
		this.batchTimer = setTimeout(() => this.processBatch(), BATCH_DEBOUNCE_DELAY_MS)
	}

	private async processBatch(): Promise<void> {
		if (this.isProcessing || this.accumulatedEvents.size === 0) {
			return
		}

		this.isProcessing = true
		const events = new Map(this.accumulatedEvents)
		this.accumulatedEvents.clear()

		const files = Array.from(events.keys())
		this.callbacks?.onBatchStart?.(files)

		let successCount = 0
		let errorCount = 0

		// Separate delete events from add/change events
		const deleteEvents: string[] = []
		const upsertEvents: { path: string; type: EventType }[] = []

		for (const [fullPath, event] of events) {
			if (event.type === "unlink") {
				deleteEvents.push(fullPath)
			} else {
				upsertEvents.push({ path: fullPath, type: event.type })
			}
		}

		// Process deletes
		if (deleteEvents.length > 0) {
			try {
				const relativePaths = deleteEvents.map((p) => getRelativePath(p, this.folderPath))
				await this.vectorStore.deletePointsByMultipleFilePaths(relativePaths, this.folderId)
				for (const fullPath of deleteEvents) {
					await this.cacheManager.deleteHash(fullPath)
				}
				successCount += deleteEvents.length
			} catch (error) {
				console.error("Error deleting points:", error)
				errorCount += deleteEvents.length
				this.callbacks?.onError?.(error instanceof Error ? error : new Error(String(error)))
			}
		}

		// Process add/change events in batches
		const allBlocks: { block: CodeBlock; text: string; filePath: string; fileHash: string }[] = []

		for (let i = 0; i < upsertEvents.length; i += FILE_PROCESSING_CONCURRENCY) {
			const batch = upsertEvents.slice(i, i + FILE_PROCESSING_CONCURRENCY)

			await Promise.all(
				batch.map(async (event, idx) => {
					this.callbacks?.onBatchProgress?.(i + idx, upsertEvents.length, event.path)

					try {
						const result = await this.processFile(event.path)
						if (result) {
							allBlocks.push(...result.blocks.map((block: CodeBlock) => ({
								block,
								text: block.content.trim(),
								filePath: event.path,
								fileHash: result.fileHash,
							})))
						}
					} catch (error) {
						console.error(`Error processing ${event.path}:`, error)
						errorCount++
						this.callbacks?.onError?.(error instanceof Error ? error : new Error(String(error)))
					}
				})
			)
		}

		// Process blocks in embedding batches
		if (allBlocks.length > 0) {
			for (let i = 0; i < allBlocks.length; i += BATCH_SEGMENT_THRESHOLD) {
				const batch = allBlocks.slice(i, i + BATCH_SEGMENT_THRESHOLD)

				// Build enriched content with parent context
				const buildContextPrefix = (block: CodeBlock): string => {
					const parts: string[] = []
					if (block.parentContext) {
						if (block.parentContext.namespace) {
							parts.push(`// Namespace: ${block.parentContext.namespace}`)
						}
						if (block.parentContext.moduleName) {
							parts.push(`// Module: ${block.parentContext.moduleName}`)
						}
						if (block.parentContext.className) {
							parts.push(`// Class: ${block.parentContext.className}`)
						}
						if (block.parentContext.parentFunction) {
							parts.push(`// Parent: ${block.parentContext.parentFunction}`)
						}
					}
					return parts.length > 0 ? parts.join("\n") + "\n" : ""
				}

				// Enrich blocks with LSP data if available
				let enrichedBatch: Array<{ block: CodeBlock; text: string; filePath: string; fileHash: string; enrichedContent?: string; enrichment?: { typeSignature?: string; documentation?: string } }> = batch.map(item => ({
					...item,
					text: buildContextPrefix(item.block) + item.text,
				}))
				if (this.lspEnricher) {
					// Group by file for efficient LSP enrichment
					const blocksByFile = new Map<string, { indices: number[]; blocks: CodeBlock[] }>()
					for (let j = 0; j < batch.length; j++) {
						const filePath = batch[j].filePath
						if (!blocksByFile.has(filePath)) {
							blocksByFile.set(filePath, { indices: [], blocks: [] })
						}
						blocksByFile.get(filePath)!.indices.push(j)
						blocksByFile.get(filePath)!.blocks.push(batch[j].block)
					}

					// Enrich each file's blocks
					const enrichments = new Map<number, EnrichedCodeBlock>()
					for (const [filePath, { indices, blocks }] of blocksByFile) {
						try {
							const fileEnrichedBlocks = await this.lspEnricher.enrichBlocks(blocks, filePath)
							for (let j = 0; j < indices.length; j++) {
								enrichments.set(indices[j], fileEnrichedBlocks[j])
							}
						} catch (error) {
							console.warn(`LSP enrichment failed for ${filePath}:`, error)
						}
					}

					// Apply enrichments
					enrichedBatch = batch.map((item, idx) => {
						const enriched = enrichments.get(idx)
						if (enriched) {
							return {
								...item,
								text: enriched.enrichedContent.trim(),
								enrichedContent: enriched.enrichedContent,
								enrichment: enriched.enrichment,
							}
						}
						return item
					})
				}

				const texts = enrichedBatch.map(b => b.text)

				let attempts = 0
				let success = false

				while (attempts < MAX_BATCH_RETRIES && !success) {
					attempts++
					try {
						// Delete old points for modified files
						const modifiedFiles = [...new Set(enrichedBatch.map(b => getRelativePath(b.filePath, this.folderPath)))]
						await this.vectorStore.deletePointsByMultipleFilePaths(modifiedFiles, this.folderId)

						// Check embedding cache for existing embeddings
						const segmentHashes = enrichedBatch.map((b) => b.block.segmentHash)
						const cachedEmbeddings = this.embeddingCache 
							? await this.embeddingCache.getEmbeddings(segmentHashes) 
							: new Map<string, number[]>()

						// Separate cached and uncached blocks, filtering invalid texts
						const uncachedIndices: number[] = []
						const uncachedTexts: string[] = []
						for (let j = 0; j < enrichedBatch.length; j++) {
							if (!cachedEmbeddings.has(enrichedBatch[j].block.segmentHash)) {
								const text = texts[j]
								if (!text || typeof text !== "string" || text.trim() === "") {
									const block = enrichedBatch[j].block
									console.warn(`[CodeSearch] Skipping invalid text for ${block.file_path}:${block.start_line} (${block.type})`)
									continue
								}
								uncachedIndices.push(j)
								uncachedTexts.push(text)
							}
						}

						// Only call embedder for uncached blocks
						let newEmbeddings: number[][] = []
						if (uncachedTexts.length > 0) {
							const result = await this.embedder.createEmbeddings(uncachedTexts)
							newEmbeddings = result.embeddings

							// Store new embeddings in cache
							if (this.embeddingCache) {
								const cacheEntries = uncachedIndices
									.map((origIdx, newIdx) => ({
										segmentHash: enrichedBatch[origIdx].block.segmentHash,
										embedding: newEmbeddings[newIdx],
									}))
									.filter((e) => e.embedding && e.embedding.length > 0)
								await this.embeddingCache.setEmbeddings(cacheEntries)
							}
						}

						// Merge cached and new embeddings
						const allEmbeddings: (number[] | null)[] = enrichedBatch.map((item, idx) => {
							const cached = cachedEmbeddings.get(item.block.segmentHash)
							if (cached) return cached

							const uncachedIdx = uncachedIndices.indexOf(idx)
							if (uncachedIdx !== -1) {
								return newEmbeddings[uncachedIdx] ?? null
							}
							return null
						})

						// Prepare points, filtering out those with empty embeddings
						const points = enrichedBatch
							.map((item, idx) => {
								const embedding = allEmbeddings[idx]
								if (!embedding || embedding.length === 0) {
									return null
								}

								const relativePath = getRelativePath(item.block.file_path, this.folderPath)
								const pointId = uuidv5(item.block.segmentHash, QDRANT_CODE_BLOCK_NAMESPACE)

								return {
									id: pointId,
									vector: embedding,
									payload: {
										filePath: relativePath,
										codeChunk: item.block.content,
										startLine: item.block.start_line,
										endLine: item.block.end_line,
										segmentHash: item.block.segmentHash,
										folderId: this.folderId,
										typeSignature: item.enrichment?.typeSignature,
										documentation: item.enrichment?.documentation,
										// Include parent context for hierarchical understanding
										parentClass: item.block.parentContext?.className,
										parentModule: item.block.parentContext?.moduleName,
										parentFunction: item.block.parentContext?.parentFunction,
										namespace: item.block.parentContext?.namespace,
									},
								}
							})
							.filter((point): point is NonNullable<typeof point> => point !== null)

						// Upsert (only if we have valid points)
						if (points.length > 0) {
							await this.vectorStore.upsertPoints(points)
						}

						const cacheHits = enrichedBatch.length - uncachedTexts.length
						if (cacheHits > 0) {
							console.log(`[EmbeddingCache] ${cacheHits}/${enrichedBatch.length} cache hits`)
						}

						// Update cache
						const processedFiles = new Set<string>()
						for (const item of enrichedBatch) {
							if (!processedFiles.has(item.filePath)) {
								await this.cacheManager.updateHash(item.filePath, item.fileHash)
								processedFiles.add(item.filePath)
							}
						}

						successCount += enrichedBatch.length
						success = true
					} catch (error) {
						if (attempts < MAX_BATCH_RETRIES) {
							await new Promise(resolve => setTimeout(resolve, INITIAL_RETRY_DELAY_MS * Math.pow(2, attempts - 1)))
						} else {
							console.error("Failed to process batch after retries:", error)
							errorCount += enrichedBatch.length
							this.callbacks?.onError?.(error instanceof Error ? error : new Error(String(error)))
						}
					}
				}
			}
		}

		this.isProcessing = false
		this.callbacks?.onBatchComplete?.({ success: successCount, errors: errorCount })

		// Check if more events accumulated during processing
		if (this.accumulatedEvents.size > 0) {
			this.scheduleBatchProcessing()
		}
	}

	private async processFile(
		filePath: string
	): Promise<{ blocks: CodeBlock[]; fileHash: string } | null> {
		// Check file exists
		if (!(await fileExists(filePath))) {
			return null
		}

		// Check file size
		const size = await getFileSize(filePath)
		if (size > MAX_FILE_SIZE_BYTES) {
			return null
		}

		// Read content
		const content = await readFileContent(filePath)
		const fileHash = createHash("sha256").update(content).digest("hex")

		// Check if unchanged
		if (this.cacheManager.getHash(filePath) === fileHash) {
			return null
		}

		// Parse file
		const blocks = await this.codeParser.parseFile(filePath, { content, fileHash })

		if (blocks.length === 0) {
			// No blocks, but update cache
			await this.cacheManager.updateHash(filePath, fileHash)
			return null
		}

		return { blocks, fileHash }
	}

	async dispose(): Promise<void> {
		if (this.batchTimer) {
			clearTimeout(this.batchTimer)
		}
		if (this.watcher) {
			await this.watcher.close()
			this.watcher = null
		}
		this.accumulatedEvents.clear()
	}
}
