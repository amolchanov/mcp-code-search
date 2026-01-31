import { z } from "zod"
import type { FolderManager } from "../folder-manager/folder-manager.js"

export const GetStatusSchema = z.object({
	folderId: z.string().optional().describe("Get status for a specific folder"),
	detailed: z.boolean().optional().default(false).describe("Include detailed progress information"),
})

export const GetErrorsSchema = z.object({
	folderId: z.string().optional().describe("Filter errors by folder ID"),
	limit: z.number().min(1).max(100).optional().default(20).describe("Maximum number of errors to return"),
	since: z.number().optional().describe("Only return errors since this timestamp (ms)"),
})

export async function getStatus(
	manager: FolderManager,
	args: z.infer<typeof GetStatusSchema>
): Promise<string> {
	try {
		if (args.folderId) {
			const status = manager.getStatus(args.folderId)
			if (!status) {
				return JSON.stringify({
					success: false,
					error: "Folder not found",
				})
			}

			const result: Record<string, unknown> = {
				success: true,
				folderId: args.folderId,
				status: status.status,
			}

			if (args.detailed) {
				result.progress = {
					processedFiles: status.progress.processedFiles,
					totalFiles: status.progress.totalFiles,
					indexedBlocks: status.progress.indexedBlocks,
					currentFile: status.progress.currentFile,
					startTime: status.progress.startTime,
					endTime: status.progress.endTime,
				}
			}

			return JSON.stringify(result)
		}

		// Get all statuses
		const allStatuses = manager.getAllStatuses()
		const statusList: Array<Record<string, unknown>> = []

		for (const [folderId, status] of allStatuses) {
			const entry: Record<string, unknown> = {
				folderId,
				status: status.status,
			}

			if (args.detailed) {
				entry.progress = {
					processedFiles: status.progress.processedFiles,
					totalFiles: status.progress.totalFiles,
					indexedBlocks: status.progress.indexedBlocks,
					currentFile: status.progress.currentFile,
				}
			}

			statusList.push(entry)
		}

		// Summary counts
		const summary = {
			total: statusList.length,
			indexed: statusList.filter((s) => s.status === "indexed").length,
			indexing: statusList.filter((s) => s.status === "indexing").length,
			pending: statusList.filter((s) => s.status === "pending").length,
			error: statusList.filter((s) => s.status === "error").length,
		}

		return JSON.stringify({
			success: true,
			summary,
			folders: statusList,
		})
	} catch (error) {
		return JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

export async function getErrors(
	manager: FolderManager,
	args: z.infer<typeof GetErrorsSchema>
): Promise<string> {
	try {
		const errors = manager.getErrors(args.folderId, args.limit, args.since)

		return JSON.stringify({
			success: true,
			count: errors.length,
			errors: errors.map((e) => ({
				folderId: e.folderId,
				filePath: e.filePath,
				error: e.error,
				timestamp: e.timestamp,
				timestampFormatted: new Date(e.timestamp).toISOString(),
			})),
		})
	} catch (error) {
		return JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}
