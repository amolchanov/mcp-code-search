import { readFile } from "fs/promises"
import { createHash } from "crypto"
import * as path from "path"
import type Parser from "web-tree-sitter"
import type { CodeBlock, ICodeParser } from "../types/index.js"
import { LanguageParser, loadRequiredLanguageParsers } from "./language-parser.js"
import { scannerExtensions, shouldUseFallbackChunking } from "./supported-extensions.js"

type SyntaxNode = Parser.SyntaxNode

// Parser constants
const MAX_BLOCK_CHARS = 1000
const MIN_BLOCK_CHARS = 50
const MIN_CHUNK_REMAINDER_CHARS = 200
const MAX_CHARS_TOLERANCE_FACTOR = 1.15

/**
 * Implementation of the code parser interface
 */
export class CodeParser implements ICodeParser {
	private loadedParsers: LanguageParser = {}
	private pendingLoads: Map<string, Promise<LanguageParser>> = new Map()
	private wasmDirectory?: string

	constructor(wasmDirectory?: string) {
		this.wasmDirectory = wasmDirectory
	}

	async parseFile(
		filePath: string,
		options?: { content?: string; fileHash?: string }
	): Promise<CodeBlock[]> {
		const ext = path.extname(filePath).toLowerCase()

		if (!this.isSupportedLanguage(ext)) {
			return []
		}

		let content: string
		let fileHash: string

		if (options?.content) {
			content = options.content
			fileHash = options.fileHash || this.createFileHash(content)
		} else {
			try {
				content = await readFile(filePath, "utf8")
				fileHash = this.createFileHash(content)
			} catch (error) {
				console.error(`Error reading file ${filePath}:`, error)
				return []
			}
		}

		return this.parseContent(filePath, content, fileHash)
	}

	private isSupportedLanguage(extension: string): boolean {
		return scannerExtensions.includes(extension)
	}

	private createFileHash(content: string): string {
		return createHash("sha256").update(content).digest("hex")
	}

	private async parseContent(filePath: string, content: string, fileHash: string): Promise<CodeBlock[]> {
		const ext = path.extname(filePath).slice(1).toLowerCase()
		const seenSegmentHashes = new Set<string>()

		// Handle markdown files specially
		if (ext === "md" || ext === "markdown") {
			return this.parseMarkdownContent(filePath, content, fileHash, seenSegmentHashes)
		}

		// Check if this extension should use fallback chunking
		if (shouldUseFallbackChunking(`.${ext}`)) {
			return this._performFallbackChunking(filePath, content, fileHash, seenSegmentHashes)
		}

		// Load parser if not already loaded
		if (!this.loadedParsers[ext]) {
			const pendingLoad = this.pendingLoads.get(ext)
			if (pendingLoad) {
				try {
					await pendingLoad
				} catch (error) {
					console.error(`Error in pending parser load for ${filePath}:`, error)
					return []
				}
			} else {
				const loadPromise = loadRequiredLanguageParsers([filePath], this.wasmDirectory)
				this.pendingLoads.set(ext, loadPromise)
				try {
					const newParsers = await loadPromise
					if (newParsers) {
						this.loadedParsers = { ...this.loadedParsers, ...newParsers }
					}
				} catch (error) {
					console.error(`Error loading language parser for ${filePath}:`, error)
					return []
				} finally {
					this.pendingLoads.delete(ext)
				}
			}
		}

		const language = this.loadedParsers[ext]
		if (!language) {
			console.warn(`No parser available for file extension: ${ext}`)
			return this._performFallbackChunking(filePath, content, fileHash, seenSegmentHashes)
		}

		const tree = language.parser.parse(content)
		const captures = tree ? language.query.captures(tree.rootNode) : []

		if (captures.length === 0) {
			if (content.length >= MIN_BLOCK_CHARS) {
				return this._performFallbackChunking(filePath, content, fileHash, seenSegmentHashes)
			} else {
				return []
			}
		}

		const results: CodeBlock[] = []
		const queue: SyntaxNode[] = Array.from(captures).map((capture) => capture.node)

		while (queue.length > 0) {
			const currentNode = queue.shift()!

			if (currentNode.text.length >= MIN_BLOCK_CHARS) {
				if (currentNode.text.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR) {
					if (currentNode.children.filter((child: SyntaxNode | null) => child !== null).length > 0) {
						queue.push(...currentNode.children.filter((child: SyntaxNode | null) => child !== null))
					} else {
						const chunkedBlocks = this._chunkLeafNodeByLines(
							currentNode,
							filePath,
							fileHash,
							seenSegmentHashes
						)
						results.push(...chunkedBlocks)
					}
				} else {
					const identifier =
						currentNode.childForFieldName("name")?.text ||
						currentNode.children.find((c: SyntaxNode | null) => c?.type === "identifier")?.text ||
						null
					const type = currentNode.type
					const start_line = currentNode.startPosition.row + 1
					const end_line = currentNode.endPosition.row + 1
					const nodeContent = currentNode.text
					const contentPreview = nodeContent.slice(0, 100)
					const segmentHash = createHash("sha256")
						.update(`${filePath}-${start_line}-${end_line}-${nodeContent.length}-${contentPreview}`)
						.digest("hex")

					if (!seenSegmentHashes.has(segmentHash)) {
						seenSegmentHashes.add(segmentHash)
						results.push({
							file_path: filePath,
							identifier,
							type,
							start_line,
							end_line,
							content: nodeContent,
							segmentHash,
							fileHash,
						})
					}
				}
			}
		}

		return results
	}

	private _chunkTextByLines(
		lines: string[],
		filePath: string,
		fileHash: string,
		chunkType: string,
		seenSegmentHashes: Set<string>,
		baseStartLine: number = 1
	): CodeBlock[] {
		const chunks: CodeBlock[] = []
		let currentChunkLines: string[] = []
		let currentChunkLength = 0
		let chunkStartLineIndex = 0
		const effectiveMaxChars = MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR

		const finalizeChunk = (endLineIndex: number) => {
			if (currentChunkLength >= MIN_BLOCK_CHARS && currentChunkLines.length > 0) {
				const chunkContent = currentChunkLines.join("\n")
				const startLine = baseStartLine + chunkStartLineIndex
				const endLine = baseStartLine + endLineIndex
				const contentPreview = chunkContent.slice(0, 100)
				const segmentHash = createHash("sha256")
					.update(`${filePath}-${startLine}-${endLine}-${chunkContent.length}-${contentPreview}`)
					.digest("hex")

				if (!seenSegmentHashes.has(segmentHash)) {
					seenSegmentHashes.add(segmentHash)
					chunks.push({
						file_path: filePath,
						identifier: null,
						type: chunkType,
						start_line: startLine,
						end_line: endLine,
						content: chunkContent,
						segmentHash,
						fileHash,
					})
				}
			}
			currentChunkLines = []
			currentChunkLength = 0
			chunkStartLineIndex = endLineIndex + 1
		}

		const createSegmentBlock = (segment: string, originalLineNumber: number, startCharIndex: number) => {
			const segmentPreview = segment.slice(0, 100)
			const segmentHash = createHash("sha256")
				.update(
					`${filePath}-${originalLineNumber}-${originalLineNumber}-${startCharIndex}-${segment.length}-${segmentPreview}`
				)
				.digest("hex")

			if (!seenSegmentHashes.has(segmentHash)) {
				seenSegmentHashes.add(segmentHash)
				chunks.push({
					file_path: filePath,
					identifier: null,
					type: `${chunkType}_segment`,
					start_line: originalLineNumber,
					end_line: originalLineNumber,
					content: segment,
					segmentHash,
					fileHash,
				})
			}
		}

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			const lineLength = line.length + (i < lines.length - 1 ? 1 : 0)
			const originalLineNumber = baseStartLine + i

			if (lineLength > effectiveMaxChars) {
				if (currentChunkLines.length > 0) {
					finalizeChunk(i - 1)
				}

				let remainingLineContent = line
				let currentSegmentStartChar = 0
				while (remainingLineContent.length > 0) {
					const segment = remainingLineContent.substring(0, MAX_BLOCK_CHARS)
					remainingLineContent = remainingLineContent.substring(MAX_BLOCK_CHARS)
					createSegmentBlock(segment, originalLineNumber, currentSegmentStartChar)
					currentSegmentStartChar += MAX_BLOCK_CHARS
				}
				chunkStartLineIndex = i + 1
				continue
			}

			if (currentChunkLength > 0 && currentChunkLength + lineLength > effectiveMaxChars) {
				let splitIndex = i - 1
				let remainderLength = 0
				for (let j = i; j < lines.length; j++) {
					remainderLength += lines[j].length + (j < lines.length - 1 ? 1 : 0)
				}

				if (
					currentChunkLength >= MIN_BLOCK_CHARS &&
					remainderLength < MIN_CHUNK_REMAINDER_CHARS &&
					currentChunkLines.length > 1
				) {
					for (let k = i - 2; k >= chunkStartLineIndex; k--) {
						const potentialChunkLines = lines.slice(chunkStartLineIndex, k + 1)
						const potentialChunkLength = potentialChunkLines.join("\n").length + 1
						const potentialNextChunkLines = lines.slice(k + 1)
						const potentialNextChunkLength = potentialNextChunkLines.join("\n").length + 1

						if (
							potentialChunkLength >= MIN_BLOCK_CHARS &&
							potentialNextChunkLength >= MIN_CHUNK_REMAINDER_CHARS
						) {
							splitIndex = k
							break
						}
					}
				}

				finalizeChunk(splitIndex)

				if (i >= chunkStartLineIndex) {
					currentChunkLines.push(line)
					currentChunkLength += lineLength
				} else {
					i = chunkStartLineIndex - 1
					continue
				}
			} else {
				currentChunkLines.push(line)
				currentChunkLength += lineLength
			}
		}

		if (currentChunkLines.length > 0) {
			finalizeChunk(lines.length - 1)
		}

		return chunks
	}

	private _performFallbackChunking(
		filePath: string,
		content: string,
		fileHash: string,
		seenSegmentHashes: Set<string>
	): CodeBlock[] {
		const lines = content.split("\n")
		return this._chunkTextByLines(lines, filePath, fileHash, "fallback_chunk", seenSegmentHashes)
	}

	private _chunkLeafNodeByLines(
		node: SyntaxNode,
		filePath: string,
		fileHash: string,
		seenSegmentHashes: Set<string>
	): CodeBlock[] {
		const lines = node.text.split("\n")
		const baseStartLine = node.startPosition.row + 1
		return this._chunkTextByLines(lines, filePath, fileHash, node.type, seenSegmentHashes, baseStartLine)
	}

	private parseMarkdownContent(
		filePath: string,
		content: string,
		fileHash: string,
		seenSegmentHashes: Set<string>
	): CodeBlock[] {
		const lines = content.split("\n")
		const results: CodeBlock[] = []

		// Simple markdown header parsing
		const headerRegex = /^(#{1,6})\s+(.+)$/
		let currentSectionStart = 0
		let currentHeader: string | null = null
		let currentHeaderLevel = 0

		for (let i = 0; i <= lines.length; i++) {
			const line = i < lines.length ? lines[i] : null
			const match = line?.match(headerRegex)

			if (match || i === lines.length) {
				// Process previous section
				if (currentSectionStart < i && i > 0) {
					const sectionLines = lines.slice(currentSectionStart, i)
					const sectionContent = sectionLines.join("\n").trim()

					if (sectionContent.length >= MIN_BLOCK_CHARS) {
						const startLine = currentSectionStart + 1
						const endLine = i
						const contentPreview = sectionContent.slice(0, 100)
						const segmentHash = createHash("sha256")
							.update(`${filePath}-${startLine}-${endLine}-${sectionContent.length}-${contentPreview}`)
							.digest("hex")

						if (!seenSegmentHashes.has(segmentHash)) {
							seenSegmentHashes.add(segmentHash)
							results.push({
								file_path: filePath,
								identifier: currentHeader,
								type: currentHeader ? `markdown_header_h${currentHeaderLevel}` : "markdown_content",
								start_line: startLine,
								end_line: endLine,
								content: sectionContent,
								segmentHash,
								fileHash,
							})
						}
					}
				}

				// Start new section
				if (match) {
					currentSectionStart = i
					currentHeaderLevel = match[1].length
					currentHeader = match[2].trim()
				}
			}
		}

		return results
	}
}

// Export a singleton instance
export const codeParser = new CodeParser()
