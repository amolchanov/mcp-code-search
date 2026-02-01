import { QdrantClient, Schemas } from "@qdrant/js-client-rest"
import * as path from "path"
import { v5 as uuidv5 } from "uuid"
import type { IVectorStore, PointStruct, VectorStoreSearchResult, SearchFilter, Payload } from "../types/index.js"

const QDRANT_CODE_BLOCK_NAMESPACE = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
const DEFAULT_SEARCH_MIN_SCORE = 0.4
const DEFAULT_MAX_SEARCH_RESULTS = 20

/**
 * Qdrant implementation of the vector store interface with multi-folder support
 */
export class QdrantVectorStore implements IVectorStore {
	private readonly vectorSize: number
	private readonly DISTANCE_METRIC = "Cosine"
	private client: QdrantClient
	private readonly collectionName: string
	private readonly qdrantUrl: string

	constructor(url?: string, vectorSize?: number, apiKey?: string) {
		const parsedUrl = this.parseQdrantUrl(url)
		this.qdrantUrl = parsedUrl
		this.vectorSize = vectorSize || 1536
		this.collectionName = "code-search-main"

		try {
			const urlObj = new URL(parsedUrl)
			let port: number
			let useHttps: boolean

			if (urlObj.port) {
				port = Number(urlObj.port)
				useHttps = urlObj.protocol === "https:"
			} else {
				if (urlObj.protocol === "https:") {
					port = 443
					useHttps = true
				} else {
					port = 80
					useHttps = false
				}
			}

			this.client = new QdrantClient({
				host: urlObj.hostname,
				https: useHttps,
				port: port,
				prefix: urlObj.pathname === "/" ? undefined : urlObj.pathname.replace(/\/+$/, ""),
				apiKey,
				headers: {
					"User-Agent": "Code-Search-MCP",
				},
			})
		} catch {
			this.client = new QdrantClient({
				url: parsedUrl,
				apiKey,
				headers: {
					"User-Agent": "Code-Search-MCP",
				},
			})
		}
	}

	private parseQdrantUrl(url: string | undefined): string {
		if (!url || url.trim() === "") {
			return "http://localhost:6333"
		}

		const trimmedUrl = url.trim()

		if (!trimmedUrl.startsWith("http://") && !trimmedUrl.startsWith("https://") && !trimmedUrl.includes("://")) {
			return this.parseHostname(trimmedUrl)
		}

		try {
			new URL(trimmedUrl)
			return trimmedUrl
		} catch {
			return this.parseHostname(trimmedUrl)
		}
	}

	private parseHostname(hostname: string): string {
		if (hostname.includes(":")) {
			return hostname.startsWith("http") ? hostname : `http://${hostname}`
		} else {
			return `http://${hostname}`
		}
	}

	private async getCollectionInfo(): Promise<Schemas["CollectionInfo"] | null> {
		try {
			const collectionInfo = await this.client.getCollection(this.collectionName)
			return collectionInfo
		} catch (error) {
			if (error instanceof Error) {
				console.warn(`Warning during getCollectionInfo for "${this.collectionName}":`, error.message)
			}
			return null
		}
	}

	async initialize(): Promise<boolean> {
		let created = false
		try {
			const collectionInfo = await this.getCollectionInfo()

			if (collectionInfo === null) {
				await this.client.createCollection(this.collectionName, {
					vectors: {
						size: this.vectorSize,
						distance: this.DISTANCE_METRIC,
						on_disk: true,
					},
					hnsw_config: {
						m: 64,
						ef_construct: 512,
						on_disk: true,
					},
				})
				created = true
			} else {
				const vectorsConfig = collectionInfo.config?.params?.vectors
				let existingVectorSize: number

				if (typeof vectorsConfig === "number") {
					existingVectorSize = vectorsConfig
				} else if (
					vectorsConfig &&
					typeof vectorsConfig === "object" &&
					"size" in vectorsConfig &&
					typeof vectorsConfig.size === "number"
				) {
					existingVectorSize = vectorsConfig.size
				} else {
					existingVectorSize = 0
				}

				if (existingVectorSize !== this.vectorSize) {
					created = await this._recreateCollectionWithNewDimension(existingVectorSize)
				}
			}

			await this._createPayloadIndexes()
			return created
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			console.error(`Failed to initialize Qdrant collection "${this.collectionName}":`, errorMessage)
			throw new Error(`Failed to connect to Qdrant at ${this.qdrantUrl}: ${errorMessage}`)
		}
	}

	private async _recreateCollectionWithNewDimension(existingVectorSize: number): Promise<boolean> {
		console.warn(
			`Collection ${this.collectionName} exists with vector size ${existingVectorSize}, but expected ${this.vectorSize}. Recreating collection.`
		)

		try {
			await this.client.deleteCollection(this.collectionName)
			await new Promise((resolve) => setTimeout(resolve, 100))

			await this.client.createCollection(this.collectionName, {
				vectors: {
					size: this.vectorSize,
					distance: this.DISTANCE_METRIC,
					on_disk: true,
				},
				hnsw_config: {
					m: 64,
					ef_construct: 512,
					on_disk: true,
				},
			})
			return true
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			throw new Error(`Failed to recreate collection for dimension change: ${errorMessage}`)
		}
	}

	private async _createPayloadIndexes(): Promise<void> {
		const indexes = [
			{ field_name: "type", field_schema: "keyword" as const },
			{ field_name: "folderId", field_schema: "keyword" as const },
		]

		// Path segment indexes
		for (let i = 0; i <= 4; i++) {
			indexes.push({ field_name: `pathSegments.${i}`, field_schema: "keyword" as const })
		}

		for (const index of indexes) {
			try {
				await this.client.createPayloadIndex(this.collectionName, index)
			} catch (error) {
				const errorMessage = (error instanceof Error ? error.message : "").toLowerCase()
				if (!errorMessage.includes("already exists")) {
					console.warn(`Could not create payload index for ${index.field_name}:`, errorMessage)
				}
			}
		}
	}

	async upsertPoints(points: PointStruct[]): Promise<void> {
		try {
			const processedPoints = points.map((point) => {
				const payload = point.payload as Record<string, unknown>
				if (payload?.filePath && typeof payload.filePath === "string") {
					const segments = payload.filePath.split(path.sep).filter(Boolean)
					const pathSegments = segments.reduce(
						(acc: Record<string, string>, segment: string, index: number) => {
							acc[index.toString()] = segment
							return acc
						},
						{}
					)
					return {
						...point,
						payload: {
							...payload,
							pathSegments,
						},
					}
				}
				return point
			})

			await this.client.upsert(this.collectionName, {
				points: processedPoints,
				wait: true,
			})
		} catch (error) {
			console.error("Failed to upsert points:", error)
			throw error
		}
	}

	private isPayloadValid(payload: Record<string, unknown> | null | undefined): payload is Payload {
		if (!payload) return false
		const validKeys = ["filePath", "codeChunk", "startLine", "endLine", "folderId"]
		return validKeys.every((key) => key in payload)
	}

	async search(
		queryVector: number[],
		filter?: SearchFilter,
		minScore?: number,
		maxResults?: number
	): Promise<VectorStoreSearchResult[]> {
		try {
			const mustConditions: Array<{ key: string; match: { value: string } }> = []
			const mustNotConditions: Array<{ key: string; match: { value: string } }> = [
				{ key: "type", match: { value: "metadata" } },
			]

			// Add folderId filter
			if (filter?.folderId) {
				mustConditions.push({ key: "folderId", match: { value: filter.folderId } })
			}

			// Add path prefix filter
			if (filter?.pathPrefix) {
				const normalizedPrefix = path.posix.normalize(filter.pathPrefix.replace(/\\/g, "/"))
				if (normalizedPrefix !== "." && normalizedPrefix !== "./") {
					const cleanedPrefix = normalizedPrefix.startsWith("./")
						? normalizedPrefix.slice(2)
						: normalizedPrefix
					const segments = cleanedPrefix.split("/").filter(Boolean)
					segments.forEach((segment, index) => {
						mustConditions.push({ key: `pathSegments.${index}`, match: { value: segment } })
					})
				}
			}

			const searchFilter: { must?: typeof mustConditions; must_not: typeof mustNotConditions } = {
				must_not: mustNotConditions,
			}
			if (mustConditions.length > 0) {
				searchFilter.must = mustConditions
			}

			const searchRequest = {
				query: queryVector,
				filter: searchFilter,
				score_threshold: minScore ?? DEFAULT_SEARCH_MIN_SCORE,
				limit: maxResults ?? DEFAULT_MAX_SEARCH_RESULTS,
				params: {
					hnsw_ef: 128,
					exact: false,
				},
				with_payload: {
					include: ["filePath", "codeChunk", "startLine", "endLine", "folderId", "pathSegments"],
				},
			}

			const operationResult = await this.client.query(this.collectionName, searchRequest)
			const filteredPoints = operationResult.points.filter((p) =>
				this.isPayloadValid(p.payload as Record<string, unknown>)
			)

			// Apply file type filter in post-processing if needed
			let results = filteredPoints as VectorStoreSearchResult[]
			if (filter?.fileTypes && filter.fileTypes.length > 0) {
				results = results.filter((r) => {
					const filePath = (r.payload as Payload)?.filePath
					if (!filePath) return false
					const ext = path.extname(filePath).toLowerCase()
					return filter.fileTypes!.some((ft) => {
						const normalizedFt = ft.startsWith(".") ? ft.toLowerCase() : `.${ft.toLowerCase()}`
						return ext === normalizedFt
					})
				})
			}

			return results
		} catch (error) {
			console.error("Failed to search points:", error)
			throw error
		}
	}

	async deletePointsByFilePath(filePath: string, folderId: string): Promise<void> {
		return this.deletePointsByMultipleFilePaths([filePath], folderId)
	}

	async deletePointsByMultipleFilePaths(filePaths: string[], folderId: string): Promise<void> {
		if (filePaths.length === 0) return

		try {
			if (!(await this.collectionExists())) {
				console.warn(`Skipping deletion - collection "${this.collectionName}" does not exist`)
				return
			}

			const filters = filePaths.map((filePath) => {
				const normalizedPath = path.normalize(filePath)
				const segments = normalizedPath.split(path.sep).filter(Boolean)

				const mustConditions = [
					{ key: "folderId", match: { value: folderId } },
					...segments.map((segment, index) => ({
						key: `pathSegments.${index}`,
						match: { value: segment },
					})),
				]

				return { must: mustConditions }
			})

			const filter = filters.length === 1 ? filters[0] : { should: filters }

			await this.client.delete(this.collectionName, {
				filter,
				wait: true,
			})
		} catch (error) {
			console.error("Failed to delete points by file paths:", error)
		}
	}

	async deletePointsByFolderId(folderId: string): Promise<void> {
		try {
			if (!(await this.collectionExists())) {
				console.warn(`Skipping deletion - collection "${this.collectionName}" does not exist`)
				return
			}

			await this.client.delete(this.collectionName, {
				filter: {
					must: [{ key: "folderId", match: { value: folderId } }],
				},
				wait: true,
			})

			console.log(`Deleted all points for folder: ${folderId}`)
		} catch (error) {
			console.error(`Failed to delete points for folder ${folderId}:`, error)
			throw error
		}
	}

	async deleteCollection(): Promise<void> {
		try {
			if (await this.collectionExists()) {
				await this.client.deleteCollection(this.collectionName)
			}
		} catch (error) {
			console.error(`Failed to delete collection ${this.collectionName}:`, error)
			throw error
		}
	}

	async clearCollection(): Promise<void> {
		try {
			await this.client.delete(this.collectionName, {
				filter: { must: [] },
				wait: true,
			})
		} catch (error) {
			console.error("Failed to clear collection:", error)
			throw error
		}
	}

	async collectionExists(): Promise<boolean> {
		const collectionInfo = await this.getCollectionInfo()
		return collectionInfo !== null
	}

	async hasIndexedData(): Promise<boolean> {
		try {
			const collectionInfo = await this.getCollectionInfo()
			if (!collectionInfo) return false

			const pointsCount = collectionInfo.points_count ?? 0
			return pointsCount > 0
		} catch (error) {
			console.warn("Failed to check if collection has data:", error)
			return false
		}
	}

	async markIndexingComplete(folderId: string): Promise<void> {
		try {
			const metadataId = uuidv5(`__indexing_metadata__${folderId}`, QDRANT_CODE_BLOCK_NAMESPACE)

			await this.client.upsert(this.collectionName, {
				points: [
					{
						id: metadataId,
						vector: new Array(this.vectorSize).fill(0),
						payload: {
							type: "metadata",
							folderId,
							indexing_complete: true,
							completed_at: Date.now(),
						},
					},
				],
				wait: true,
			})
			console.log(`Marked indexing as complete for folder: ${folderId}`)
		} catch (error) {
			console.error(`Failed to mark indexing as complete for folder ${folderId}:`, error)
			throw error
		}
	}

	async markIndexingIncomplete(folderId: string): Promise<void> {
		try {
			const metadataId = uuidv5(`__indexing_metadata__${folderId}`, QDRANT_CODE_BLOCK_NAMESPACE)

			await this.client.upsert(this.collectionName, {
				points: [
					{
						id: metadataId,
						vector: new Array(this.vectorSize).fill(0),
						payload: {
							type: "metadata",
							folderId,
							indexing_complete: false,
							started_at: Date.now(),
						},
					},
				],
				wait: true,
			})
			console.log(`Marked indexing as incomplete for folder: ${folderId}`)
		} catch (error) {
			console.error(`Failed to mark indexing as incomplete for folder ${folderId}:`, error)
			throw error
		}
	}

	/**
	 * Scroll through all points in the collection with vectors
	 * Used for warming the embedding cache from existing data
	 */
	async *scrollAllPoints(
		batchSize: number = 100
	): AsyncGenerator<Array<{ segmentHash: string; vector: number[] }>> {
		let offset: string | number | undefined = undefined

		try {
			while (true) {
				const result = await this.client.scroll(this.collectionName, {
					offset,
					limit: batchSize,
					with_payload: ["segmentHash"],
					with_vector: true,
					filter: {
						must_not: [{ key: "type", match: { value: "metadata" } }],
					},
				})

				if (!result.points || result.points.length === 0) {
					break
				}

				const points: Array<{ segmentHash: string; vector: number[] }> = []
				for (const point of result.points) {
					const payload = point.payload as Record<string, unknown> | null
					const segmentHash = payload?.segmentHash as string | undefined
					const vector = point.vector as number[] | undefined

					if (segmentHash && vector && vector.length > 0) {
						points.push({ segmentHash, vector })
					}
				}

				if (points.length > 0) {
					yield points
				}

				// Handle next_page_offset which can be various types
				const nextOffset = result.next_page_offset
				if (nextOffset === null || nextOffset === undefined) {
					break
				}
				if (typeof nextOffset === "string" || typeof nextOffset === "number") {
					offset = nextOffset
				} else {
					// Unexpected type, stop iteration
					break
				}
			}
		} catch (error) {
			console.error("Failed to scroll points:", error)
			throw error
		}
	}

	/**
	 * Get total point count (excluding metadata)
	 */
	async getPointCount(): Promise<number> {
		try {
			const result = await this.client.count(this.collectionName, {
				filter: {
					must_not: [{ key: "type", match: { value: "metadata" } }],
				},
				exact: true,
			})
			return result.count
		} catch (error) {
			console.error("Failed to get point count:", error)
			return 0
		}
	}

	/**
	 * Get point count for a specific folder
	 */
	async getPointCountForFolder(folderId: string): Promise<number> {
		try {
			const result = await this.client.count(this.collectionName, {
				filter: {
					must: [{ key: "folderId", match: { value: folderId } }],
					must_not: [{ key: "type", match: { value: "metadata" } }],
				},
				exact: true,
			})
			return result.count
		} catch (error) {
			console.error(`Failed to get point count for folder ${folderId}:`, error)
			return 0
		}
	}
}
