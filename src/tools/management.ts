import { z } from "zod"
import type { FolderManager } from "../folder-manager/folder-manager.js"
import { getFolderByPath } from "../config/store.js"

// Tool schemas
export const AddFolderSchema = z.object({
	path: z.string().describe("Absolute path to the folder to index"),
	startIndexing: z.boolean().optional().default(true).describe("Whether to start indexing immediately"),
	includeExtensions: z.array(z.string()).optional().describe("File extensions to index (e.g., ['.ts', '.js']). If not specified, all supported extensions are indexed."),
})

export const RemoveFolderSchema = z.object({
	folderId: z.string().optional().describe("ID of the folder to remove"),
	path: z.string().optional().describe("Path of the folder to remove"),
})

export const ListFoldersSchema = z.object({})

export const ClearIndexSchema = z.object({
	folderId: z.string().optional().describe("ID of the folder to clear"),
	path: z.string().optional().describe("Path of the folder to clear"),
	all: z.boolean().optional().default(false).describe("Clear all folder indexes"),
})

// Tool implementations
export async function addFolder(
	manager: FolderManager,
	args: z.infer<typeof AddFolderSchema>
): Promise<string> {
	try {
		const folder = await manager.addFolder(args.path, args.startIndexing, args.includeExtensions)
		return JSON.stringify({
			success: true,
			message: `Folder added successfully`,
			folder: {
				id: folder.id,
				path: folder.path,
				name: folder.name,
				status: folder.status,
				includeExtensions: folder.includeExtensions,
			},
		})
	} catch (error) {
		return JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

export async function removeFolder(
	manager: FolderManager,
	args: z.infer<typeof RemoveFolderSchema>
): Promise<string> {
	try {
		if (!args.folderId && !args.path) {
			return JSON.stringify({
				success: false,
				error: "Either folderId or path must be provided",
			})
		}

		let removed
		if (args.folderId) {
			removed = await manager.removeFolder(args.folderId)
		} else if (args.path) {
			removed = await manager.removeFolderByPath(args.path)
		}

		if (removed) {
			return JSON.stringify({
				success: true,
				message: `Folder removed successfully`,
				folder: {
					id: removed.id,
					path: removed.path,
					name: removed.name,
				},
			})
		} else {
			return JSON.stringify({
				success: false,
				error: "Folder not found",
			})
		}
	} catch (error) {
		return JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

export async function listFolders(manager: FolderManager): Promise<string> {
	try {
		const folders = await manager.listFolders()
		const statuses = manager.getAllStatuses()

		const foldersWithStatus = folders.map((folder) => {
			const statusInfo = statuses.get(folder.id)
			return {
				id: folder.id,
				path: folder.path,
				name: folder.name,
				status: statusInfo?.status || folder.status,
				addedAt: folder.addedAt,
				lastIndexedAt: folder.lastIndexedAt,
				fileCount: folder.fileCount,
				errorCount: folder.errorCount,
				progress: statusInfo?.progress
					? {
							processedFiles: statusInfo.progress.processedFiles,
							totalFiles: statusInfo.progress.totalFiles,
							indexedBlocks: statusInfo.progress.indexedBlocks,
					  }
					: undefined,
			}
		})

		return JSON.stringify({
			success: true,
			folders: foldersWithStatus,
		})
	} catch (error) {
		return JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

export async function clearIndex(
	manager: FolderManager,
	args: z.infer<typeof ClearIndexSchema>
): Promise<string> {
	try {
		if (args.all) {
			await manager.clearAllIndexes()
			return JSON.stringify({
				success: true,
				message: "All indexes cleared successfully",
			})
		}

		if (!args.folderId && !args.path) {
			return JSON.stringify({
				success: false,
				error: "Either folderId, path, or all=true must be provided",
			})
		}

		let folderId = args.folderId
		if (!folderId && args.path) {
			const folder = await getFolderByPath(args.path)
			if (folder) {
				folderId = folder.id
			} else {
				return JSON.stringify({
					success: false,
					error: "Folder not found",
				})
			}
		}

		if (folderId) {
			await manager.clearIndex(folderId)
			return JSON.stringify({
				success: true,
				message: "Index cleared successfully",
				folderId,
			})
		}

		return JSON.stringify({
			success: false,
			error: "Folder not found",
		})
	} catch (error) {
		return JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}
