import { z } from "zod"
import type { SearchService } from "../search/index.js"

export const SearchSchema = z.object({
	query: z.string().describe("The search query for semantic code search"),
	folderId: z.string().optional().describe("Filter results to a specific folder by ID"),
	folderPath: z.string().optional().describe("Filter results to a specific folder by path"),
	fileTypes: z
		.array(z.string())
		.optional()
		.describe("Filter by file extensions (e.g., ['.ts', '.js'])"),
	pathPrefix: z.string().optional().describe("Filter by path prefix within the folder"),
	minScore: z.number().min(0).max(1).optional().describe("Minimum similarity score (0-1)"),
	maxResults: z.number().min(1).max(100).optional().describe("Maximum number of results"),
})

export async function search(
	searchService: SearchService,
	args: z.infer<typeof SearchSchema>
): Promise<string> {
	try {
		const results = await searchService.search({
			query: args.query,
			folderId: args.folderId,
			folderPath: args.folderPath,
			fileTypes: args.fileTypes,
			pathPrefix: args.pathPrefix,
			minScore: args.minScore,
			maxResults: args.maxResults,
		})

		return JSON.stringify({
			success: true,
			query: args.query,
			resultCount: results.length,
			results: results.map((r) => ({
				folderName: r.folderName,
				filePath: r.filePath,
				absolutePath: r.absolutePath,
				startLine: r.startLine,
				endLine: r.endLine,
				score: Math.round(r.score * 1000) / 1000,
				codeChunk: r.codeChunk,
			})),
		})
	} catch (error) {
		return JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}
