import * as path from "path"
import * as fs from "fs/promises"
import type { CodeBlock } from "../types/index.js"
import type {
	ILSPEnricher,
	ILSPClient,
	LSPServerStatus,
	LSPEnrichmentData,
	EnrichedCodeBlock,
	LSPEnricherOptions,
} from "./types.js"
import { DEFAULT_LSP_OPTIONS, EXTENSION_TO_LANGUAGE } from "./types.js"
import { LSPServerManager } from "./lsp-server-manager.js"
import { LSPCache } from "./lsp-cache.js"

/**
 * Service that enriches CodeBlocks with LSP information
 * Coordinates between LSP servers and the indexing pipeline
 */
export class LSPEnricher implements ILSPEnricher {
	private readonly options: LSPEnricherOptions

	constructor(
		private readonly serverManager: LSPServerManager,
		private readonly cache: LSPCache,
		options?: Partial<LSPEnricherOptions>
	) {
		this.options = { ...DEFAULT_LSP_OPTIONS, ...options }
	}

	/**
	 * Enrich code blocks with LSP data
	 * Non-blocking - returns original blocks if LSP unavailable
	 */
	async enrichBlocks(blocks: CodeBlock[], filePath: string): Promise<EnrichedCodeBlock[]> {
		if (!this.options.enabled || blocks.length === 0) {
			return blocks.map((block) => this.toEnrichedBlock(block, undefined))
		}

		const ext = path.extname(filePath).toLowerCase()
		if (!this.isLanguageSupported(ext)) {
			return blocks.map((block) => this.toEnrichedBlock(block, undefined))
		}

		// Get the workspace root (folder containing the file)
		const rootPath = await this.findWorkspaceRoot(filePath)

		// Get LSP client
		const client = await this.serverManager.getClientForFile(filePath, rootPath)
		if (!client || client.status !== "ready") {
			return blocks.map((block) => this.toEnrichedBlock(block, undefined))
		}

		// Check cache first
		const segmentHashes = blocks.map((b) => b.segmentHash)
		const cachedEnrichments = this.cache.getEnrichments(segmentHashes)

		// Determine which blocks need enrichment
		const blocksToEnrich: Array<{ index: number; block: CodeBlock }> = []
		for (let i = 0; i < blocks.length; i++) {
			if (!cachedEnrichments.has(blocks[i].segmentHash)) {
				blocksToEnrich.push({ index: i, block: blocks[i] })
			}
		}

		// If everything is cached, return immediately
		if (blocksToEnrich.length === 0) {
			return blocks.map((block) =>
				this.toEnrichedBlock(block, cachedEnrichments.get(block.segmentHash))
			)
		}

		// Read file content for LSP
		let content: string
		try {
			content = await fs.readFile(filePath, "utf-8")
		} catch {
			return blocks.map((block) =>
				this.toEnrichedBlock(block, cachedEnrichments.get(block.segmentHash))
			)
		}

		// Open document in LSP
		await client.openDocument(filePath, content)

		try {
			// Enrich blocks with concurrency limit
			const newEnrichments = new Map<string, LSPEnrichmentData>()

			// Process in batches
			const batchSize = this.options.maxConcurrentRequests
			for (let i = 0; i < blocksToEnrich.length; i += batchSize) {
				const batch = blocksToEnrich.slice(i, i + batchSize)
				const promises = batch.map(async ({ block }) => {
					const enrichment = await this.enrichSingleBlock(block, client, filePath)
					if (enrichment) {
						newEnrichments.set(block.segmentHash, enrichment)
					}
				})

				await Promise.all(promises)
			}

			// Cache new enrichments
			if (newEnrichments.size > 0) {
				const entries = Array.from(newEnrichments.entries()).map(
					([segmentHash, enrichment]) => ({
						segmentHash,
						enrichment,
					})
				)
				this.cache.setEnrichments(entries)
			}

			// Build result combining cached and new enrichments
			return blocks.map((block) => {
				const enrichment =
					cachedEnrichments.get(block.segmentHash) || newEnrichments.get(block.segmentHash)
				return this.toEnrichedBlock(block, enrichment)
			})
		} finally {
			// Close document
			await client.closeDocument(filePath)
		}
	}

	/**
	 * Enrich a single block by querying LSP for hover info
	 */
	private async enrichSingleBlock(
		block: CodeBlock,
		client: ILSPClient,
		filePath: string
	): Promise<LSPEnrichmentData | null> {
		try {
			// Find the best position to query
			// Strategy: Query at the identifier position, or start of the block
			const positions = this.extractQueryPositions(block)

			for (const pos of positions) {
				const hoverResult = await Promise.race([
					client.getHoverInfo(filePath, pos.line, pos.character),
					this.timeout(this.options.timeout),
				])

				if (hoverResult && (hoverResult.typeSignature || hoverResult.documentation)) {
					return {
						typeSignature: hoverResult.typeSignature,
						documentation: hoverResult.documentation,
						symbolKind: block.type,
					}
				}
			}

			return null
		} catch (error) {
			if (this.options.fallbackOnError) {
				return null
			}
			throw error
		}
	}

	/**
	 * Extract positions to query from a block
	 * Returns positions sorted by most likely to have useful hover info
	 */
	private extractQueryPositions(
		block: CodeBlock
	): Array<{ line: number; character: number }> {
		const positions: Array<{ line: number; character: number }> = []

		// If we have an identifier, try to find its position
		if (block.identifier) {
			const lines = block.content.split("\n")
			for (let lineOffset = 0; lineOffset < Math.min(lines.length, 5); lineOffset++) {
				const line = lines[lineOffset]
				const identifierIndex = line.indexOf(block.identifier)
				if (identifierIndex !== -1) {
					positions.push({
						line: block.start_line - 1 + lineOffset, // LSP uses 0-indexed lines
						character: identifierIndex,
					})
					break
				}
			}
		}

		// Also try the start of the block (after any leading whitespace)
		const firstLine = block.content.split("\n")[0]
		const firstNonWhitespace = firstLine.search(/\S/)
		if (firstNonWhitespace !== -1) {
			positions.push({
				line: block.start_line - 1,
				character: firstNonWhitespace,
			})
		}

		// Deduplicate
		const seen = new Set<string>()
		return positions.filter((pos) => {
			const key = `${pos.line}:${pos.character}`
			if (seen.has(key)) return false
			seen.add(key)
			return true
		})
	}

	/**
	 * Create a timeout promise
	 */
	private timeout(ms: number): Promise<null> {
		return new Promise((resolve) => setTimeout(() => resolve(null), ms))
	}

	/**
	 * Convert CodeBlock to EnrichedCodeBlock
	 */
	private toEnrichedBlock(
		block: CodeBlock,
		enrichment: LSPEnrichmentData | undefined
	): EnrichedCodeBlock {
		const enrichedContent = this.buildEnrichedContent(block, enrichment)
		return {
			...block,
			enrichment,
			enrichedContent,
		}
	}

	/**
	 * Build enriched content for embedding
	 * Prepends type signature and documentation to the code
	 */
	private buildEnrichedContent(
		block: CodeBlock,
		enrichment: LSPEnrichmentData | undefined
	): string {
		if (!enrichment) {
			return block.content
		}

		const parts: string[] = []

		if (enrichment.typeSignature) {
			parts.push(`// Type: ${enrichment.typeSignature}`)
		}

		if (enrichment.documentation) {
			// Truncate long documentation
			let doc = enrichment.documentation
			if (doc.length > 500) {
				doc = doc.substring(0, 500) + "..."
			}
			// Convert to comment format
			const docLines = doc.split("\n").map((line) => `// ${line}`)
			parts.push(docLines.join("\n"))
		}

		if (parts.length > 0) {
			return parts.join("\n") + "\n" + block.content
		}

		return block.content
	}

	/**
	 * Find workspace root for a file
	 * Looks for common project markers (package.json, .csproj, .git, etc.)
	 */
	private async findWorkspaceRoot(filePath: string): Promise<string> {
		let dir = path.dirname(filePath)
		const root = path.parse(dir).root

		const markers = [
			"package.json",
			"tsconfig.json",
			".csproj",
			".sln",
			".git",
			"Cargo.toml",
			"go.mod",
		]

		while (dir !== root) {
			for (const marker of markers) {
				try {
					await fs.access(path.join(dir, marker))
					return dir
				} catch {
					// Continue searching
				}
			}
			dir = path.dirname(dir)
		}

		// Fallback to file's directory
		return path.dirname(filePath)
	}

	isLanguageSupported(extension: string): boolean {
		const ext = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`
		return ext in EXTENSION_TO_LANGUAGE
	}

	getStatus(): Map<string, LSPServerStatus> {
		return this.serverManager.getStatuses()
	}

	async shutdown(): Promise<void> {
		await this.serverManager.shutdownAll()
		this.cache.close()
	}
}
