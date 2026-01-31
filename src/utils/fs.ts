import * as fs from "fs/promises"
import * as path from "path"

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}

/**
 * Check if a path is a directory
 */
export async function isDirectory(filePath: string): Promise<boolean> {
	try {
		const stats = await fs.stat(filePath)
		return stats.isDirectory()
	} catch {
		return false
	}
}

/**
 * Get file size in bytes
 */
export async function getFileSize(filePath: string): Promise<number> {
	const stats = await fs.stat(filePath)
	return stats.size
}

/**
 * Read file content as string
 */
export async function readFileContent(filePath: string): Promise<string> {
	return await fs.readFile(filePath, "utf-8")
}

/**
 * Get relative path from a base directory
 */
export function getRelativePath(filePath: string, basePath: string): string {
	return path.relative(basePath, filePath)
}

/**
 * Normalize path separators to forward slashes
 */
export function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, "/")
}

/**
 * List all files in a directory recursively
 */
export async function listFilesRecursively(
	dirPath: string,
	options?: {
		maxDepth?: number
		currentDepth?: number
		extensions?: string[]
	}
): Promise<string[]> {
	const { maxDepth = Infinity, currentDepth = 0, extensions } = options || {}
	const files: string[] = []

	if (currentDepth >= maxDepth) {
		return files
	}

	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true })

		for (const entry of entries) {
			const fullPath = path.join(dirPath, entry.name)

			if (entry.isDirectory()) {
				// Skip hidden directories and common non-code directories
				if (entry.name.startsWith(".") || entry.name === "node_modules") {
					continue
				}

				const subFiles = await listFilesRecursively(fullPath, {
					maxDepth,
					currentDepth: currentDepth + 1,
					extensions,
				})
				files.push(...subFiles)
			} else if (entry.isFile()) {
				if (extensions) {
					const ext = path.extname(entry.name).toLowerCase()
					if (extensions.includes(ext)) {
						files.push(fullPath)
					}
				} else {
					files.push(fullPath)
				}
			}
		}
	} catch (error) {
		console.error(`Error listing files in ${dirPath}:`, error)
	}

	return files
}
