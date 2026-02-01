import * as fs from "fs/promises"
import * as path from "path"
import { createHash } from "crypto"
import { v5 as uuidv5 } from "uuid"
import type { IEmbedder, IVectorStore, ICodeParser, ICacheManager, CodeBlock } from "../types/index.js"
import { scannerExtensions } from "../parser/supported-extensions.js"
import { createIgnoreFromGitignore, filterPathsWithIgnore, isPathInIgnoredDirectory } from "../utils/ignore.js"
import { listFilesRecursively, getRelativePath, getFileSize, readFileContent } from "../utils/fs.js"
import type { EmbeddingCache } from "../cache/embedding-cache.js"
import type { ILSPEnricher, EnrichedCodeBlock } from "../lsp/types.js"

const QDRANT_CODE_BLOCK_NAMESPACE = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024 // 1MB
const MAX_LIST_FILES_LIMIT = 50_000
const BATCH_SEGMENT_THRESHOLD = 60
const MAX_BATCH_RETRIES = 3
const INITIAL_RETRY_DELAY_MS = 500
const DEFAULT_PARSING_CONCURRENCY = 10

export interface PipelineStats {
	fileDiscoveryMs: number
	parsingMs: number
	lspEnrichmentMs: number
	embeddingMs: number
	vectorStoreMs: number
	totalMs: number
}

export interface ScanResult {
	stats: {
		processed: number
		skipped: number
	}
	totalBlockCount: number
	pipelineStats?: PipelineStats
}

export interface ScannerCallbacks {
	onError?: (error: Error) => void
	onBlocksIndexed?: (count: number) => void
	onFileParsed?: (blockCount: number) => void
	onProgress?: (processed: number, total: number, currentFile?: string) => void
	isPaused?: () => boolean
}

/**
 * Directory scanner that indexes files for a folder
 */
export class DirectoryScanner {
	private readonly batchSegmentThreshold: number
	private readonly parsingConcurrency: number

	constructor(
		private readonly folderId: string,
		private readonly folderPath: string,
		private readonly embedder: IEmbedder,
		private readonly vectorStore: IVectorStore,
		private readonly codeParser: ICodeParser,
		private readonly cacheManager: ICacheManager,
		private readonly embeddingCache?: EmbeddingCache,
		private readonly lspEnricher?: ILSPEnricher,
		batchSegmentThreshold?: number,
		parsingConcurrency?: number
	) {
		this.batchSegmentThreshold = batchSegmentThreshold || BATCH_SEGMENT_THRESHOLD
		this.parsingConcurrency = parsingConcurrency || DEFAULT_PARSING_CONCURRENCY
	}

	async scanDirectory(callbacks?: ScannerCallbacks): Promise<ScanResult> {
		const scanStartTime = Date.now()

		// Pipeline timing accumulators
		let fileDiscoveryMs = 0
		let parsingMs = 0
		let lspEnrichmentMs = 0
		let embeddingMs = 0
		let vectorStoreMs = 0

		const fileDiscoveryStart = Date.now()
		const ig = await createIgnoreFromGitignore(this.folderPath)

		// Get all files recursively
		const allFiles = await listFilesRecursively(this.folderPath, {
			extensions: scannerExtensions,
		})

		// Limit the number of files
		const limitedFiles = allFiles.slice(0, MAX_LIST_FILES_LIMIT)

		// Filter by ignore patterns
		const allowedFiles = filterPathsWithIgnore(limitedFiles, this.folderPath, ig)
		fileDiscoveryMs = Date.now() - fileDiscoveryStart

		const processedFiles = new Set<string>()
		let processedCount = 0
		let skippedCount = 0
		let totalBlockCount = 0

		// Batch accumulators
		let currentBatchBlocks: CodeBlock[] = []
		let currentBatchTexts: string[] = []
		let currentBatchFileInfos: { filePath: string; fileHash: string; isNew: boolean }[] = []

		// Timing accumulators for this scan (passed to processBatch)
		const timingAccum = { parsingMs: 0, lspEnrichmentMs: 0, embeddingMs: 0, vectorStoreMs: 0 }

		// Process files with limited concurrency
		const processFile = async (filePath: string, index: number): Promise<void> => {
			try {
				callbacks?.onProgress?.(index, allowedFiles.length, filePath)

				// Check file size
				const fileSize = await getFileSize(filePath)
				if (fileSize > MAX_FILE_SIZE_BYTES) {
					skippedCount++
					return
				}

				// Read file content
				const content = await readFileContent(filePath)
				const currentFileHash = createHash("sha256").update(content).digest("hex")
				processedFiles.add(filePath)

				// Check against cache
				const cachedFileHash = this.cacheManager.getHash(filePath)
				const isNewFile = !cachedFileHash
				if (cachedFileHash === currentFileHash) {
					skippedCount++
					return
				}

				// Parse file
				const parseStart = Date.now()
				const blocks = await this.codeParser.parseFile(filePath, {
					content,
					fileHash: currentFileHash,
				})
				timingAccum.parsingMs += Date.now() - parseStart
				callbacks?.onFileParsed?.(blocks.length)
				processedCount++

				if (blocks.length > 0) {
					let addedBlocksFromFile = false
					for (const block of blocks) {
						const trimmedContent = block.content.trim()
						if (trimmedContent) {
							currentBatchBlocks.push(block)
							currentBatchTexts.push(trimmedContent)
							addedBlocksFromFile = true

							// Process batch if threshold reached
							if (currentBatchBlocks.length >= this.batchSegmentThreshold) {
								await this.processBatch(
									currentBatchBlocks,
									currentBatchTexts,
									currentBatchFileInfos,
									callbacks,
									timingAccum
								)
								currentBatchBlocks = []
								currentBatchTexts = []
								currentBatchFileInfos = []
							}
						}
					}

					if (addedBlocksFromFile) {
						totalBlockCount += blocks.length
						currentBatchFileInfos.push({
							filePath,
							fileHash: currentFileHash,
							isNew: isNewFile,
						})
					}
				} else {
					// No blocks, but update cache
					await this.cacheManager.updateHash(filePath, currentFileHash)
				}
			} catch (error) {
				console.error(`Error processing file ${filePath}:`, error)
				callbacks?.onError?.(
					error instanceof Error ? error : new Error(`Unknown error processing ${filePath}`)
				)
			}
		}

		// Process files in batches with concurrency
		for (let i = 0; i < allowedFiles.length; i += this.parsingConcurrency) {
			// Wait while paused
			while (callbacks?.isPaused?.()) {
				await new Promise((resolve) => setTimeout(resolve, 500))
			}

			const batch = allowedFiles.slice(i, i + this.parsingConcurrency)
			await Promise.all(batch.map((file, idx) => processFile(file, i + idx)))
		}

		// Process remaining batch
		if (currentBatchBlocks.length > 0) {
			await this.processBatch(currentBatchBlocks, currentBatchTexts, currentBatchFileInfos, callbacks, timingAccum)
		}

		// Handle deleted files
		const oldHashes = this.cacheManager.getAllHashes()
		for (const cachedFilePath of Object.keys(oldHashes)) {
			if (!processedFiles.has(cachedFilePath)) {
				try {
					const relativePath = getRelativePath(cachedFilePath, this.folderPath)
					await this.vectorStore.deletePointsByFilePath(relativePath, this.folderId)
					await this.cacheManager.deleteHash(cachedFilePath)
				} catch (error) {
					console.error(`Failed to delete points for ${cachedFilePath}:`, error)
					callbacks?.onError?.(
						error instanceof Error
							? error
							: new Error(`Failed to delete points for ${cachedFilePath}`)
					)
				}
			}
		}

		const totalMs = Date.now() - scanStartTime

		// Build pipeline stats
		const pipelineStats: PipelineStats = {
			fileDiscoveryMs,
			parsingMs: timingAccum.parsingMs,
			lspEnrichmentMs: timingAccum.lspEnrichmentMs,
			embeddingMs: timingAccum.embeddingMs,
			vectorStoreMs: timingAccum.vectorStoreMs,
			totalMs,
		}

		// Log pipeline stats
		const pct = (ms: number) => totalMs > 0 ? ((ms / totalMs) * 100).toFixed(1) : '0'
		console.log(`[PipelineStats] Discovery: ${pct(fileDiscoveryMs)}%, Parsing: ${pct(timingAccum.parsingMs)}%, LSP: ${pct(timingAccum.lspEnrichmentMs)}%, Embedding: ${pct(timingAccum.embeddingMs)}%, VectorStore: ${pct(timingAccum.vectorStoreMs)}%`)

		return {
			stats: {
				processed: processedCount,
				skipped: skippedCount,
			},
			totalBlockCount,
			pipelineStats,
		}
	}

	private async processBatch(
		batchBlocks: CodeBlock[],
		batchTexts: string[],
		batchFileInfos: { filePath: string; fileHash: string; isNew: boolean }[],
		callbacks?: ScannerCallbacks,
		timingAccum?: { parsingMs: number; lspEnrichmentMs: number; embeddingMs: number; vectorStoreMs: number }
	): Promise<void> {
		if (batchBlocks.length === 0) return

		let attempts = 0
		let success = false
		let lastError: Error | null = null

		while (attempts < MAX_BATCH_RETRIES && !success) {
			attempts++
			try {
				// Delete old points for modified files
				const vsDeleteStart = Date.now()
				const modifiedFilePaths = [
					...new Set(
						batchFileInfos
							.filter((info) => !info.isNew)
							.map((info) => getRelativePath(info.filePath, this.folderPath))
					),
				]
				if (modifiedFilePaths.length > 0) {
					await this.vectorStore.deletePointsByMultipleFilePaths(modifiedFilePaths, this.folderId)
				}
				if (timingAccum) timingAccum.vectorStoreMs += Date.now() - vsDeleteStart

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

				// Enrich blocks with LSP data (if enricher available)
				let enrichedBlocks: EnrichedCodeBlock[] = batchBlocks.map((block) => ({
					...block,
					enrichedContent: buildContextPrefix(block) + block.content,
				}))

				const lspStart = Date.now()
				if (this.lspEnricher) {
					// Group blocks by file for efficient LSP enrichment
					const blocksByFile = new Map<string, { indices: number[]; blocks: CodeBlock[] }>()
					for (let i = 0; i < batchBlocks.length; i++) {
						const filePath = batchBlocks[i].file_path
						if (!blocksByFile.has(filePath)) {
							blocksByFile.set(filePath, { indices: [], blocks: [] })
						}
						blocksByFile.get(filePath)!.indices.push(i)
						blocksByFile.get(filePath)!.blocks.push(batchBlocks[i])
					}

					// Enrich each file's blocks
					for (const [filePath, { indices, blocks }] of blocksByFile) {
						try {
							const fileEnrichedBlocks = await this.lspEnricher.enrichBlocks(blocks, filePath)
							for (let j = 0; j < indices.length; j++) {
								enrichedBlocks[indices[j]] = fileEnrichedBlocks[j]
							}
						} catch (error) {
							// LSP enrichment failed - continue with unenriched blocks
							console.warn(`LSP enrichment failed for ${filePath}:`, error)
						}
					}
				}
				if (timingAccum) timingAccum.lspEnrichmentMs += Date.now() - lspStart

				// Use enrichedContent for embedding (includes type signatures and docs)
				const textsForEmbedding = enrichedBlocks.map((b) => b.enrichedContent.trim())

				// Check embedding cache for existing embeddings
				const segmentHashes = batchBlocks.map((b) => b.segmentHash)
				const cachedEmbeddings = this.embeddingCache?.getEmbeddings(segmentHashes) ?? new Map()

				// Separate cached and uncached blocks
				const uncachedIndices: number[] = []
				const uncachedTexts: string[] = []
				for (let i = 0; i < batchBlocks.length; i++) {
					if (!cachedEmbeddings.has(batchBlocks[i].segmentHash)) {
						uncachedIndices.push(i)
						uncachedTexts.push(textsForEmbedding[i])
					}
				}

				// Only call embedder for uncached blocks
				const embeddingStart = Date.now()
				let newEmbeddings: number[][] = []
				if (uncachedTexts.length > 0) {
					const result = await this.embedder.createEmbeddings(uncachedTexts)
					newEmbeddings = result.embeddings

					// Store new embeddings in cache
					if (this.embeddingCache) {
						const cacheEntries = uncachedIndices
							.map((origIdx, newIdx) => ({
								segmentHash: batchBlocks[origIdx].segmentHash,
								embedding: newEmbeddings[newIdx],
							}))
							.filter((e) => e.embedding && e.embedding.length > 0)
						this.embeddingCache.setEmbeddings(cacheEntries)
					}
				}
				if (timingAccum) timingAccum.embeddingMs += Date.now() - embeddingStart

				// Merge cached and new embeddings
				const allEmbeddings: (number[] | null)[] = batchBlocks.map((block, idx) => {
					const cached = cachedEmbeddings.get(block.segmentHash)
					if (cached) return cached

					const uncachedIdx = uncachedIndices.indexOf(idx)
					if (uncachedIdx !== -1) {
						return newEmbeddings[uncachedIdx] ?? null
					}
					return null
				})

				// Prepare points for Qdrant, filtering out those with empty embeddings
				const points = enrichedBlocks
					.map((block, index) => {
						const embedding = allEmbeddings[index]
						// Skip blocks with empty or missing embeddings
						if (!embedding || embedding.length === 0) {
							console.warn(`Skipping block at index ${index} - no embedding generated`)
							return null
						}

						const relativePath = getRelativePath(block.file_path, this.folderPath)
						const pointId = uuidv5(block.segmentHash, QDRANT_CODE_BLOCK_NAMESPACE)

						return {
							id: pointId,
							vector: embedding,
							payload: {
								filePath: relativePath,
								codeChunk: block.content,
								startLine: block.start_line,
								endLine: block.end_line,
								segmentHash: block.segmentHash,
								folderId: this.folderId,
								// Include enrichment data if available
								typeSignature: block.enrichment?.typeSignature,
								documentation: block.enrichment?.documentation,
								// Include parent context for hierarchical understanding
								parentClass: block.parentContext?.className,
								parentModule: block.parentContext?.moduleName,
								parentFunction: block.parentContext?.parentFunction,
								namespace: block.parentContext?.namespace,
							},
						}
					})
					.filter((point): point is NonNullable<typeof point> => point !== null)

				// Upsert points (only if we have valid points)
				if (points.length > 0) {
					await this.vectorStore.upsertPoints(points)
				}

				const cacheHits = batchBlocks.length - uncachedTexts.length
				if (cacheHits > 0) {
					console.log(`[EmbeddingCache] ${cacheHits}/${batchBlocks.length} cache hits`)
				}
				callbacks?.onBlocksIndexed?.(batchBlocks.length)

				// Update cache
				for (const fileInfo of batchFileInfos) {
					await this.cacheManager.updateHash(fileInfo.filePath, fileInfo.fileHash)
				}

				success = true
			} catch (error) {
				lastError = error as Error
				console.error(`Error processing batch (attempt ${attempts}):`, error)

				if (attempts < MAX_BATCH_RETRIES) {
					const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempts - 1)
					await new Promise((resolve) => setTimeout(resolve, delay))
				}
			}
		}

		if (!success && lastError) {
			console.error(`Failed to process batch after ${MAX_BATCH_RETRIES} attempts`)
			callbacks?.onError?.(
				new Error(`Failed to process batch after ${MAX_BATCH_RETRIES} attempts: ${lastError.message}`)
			)
		}
	}
}
