import * as fs from "fs/promises"
import * as path from "path"
import ignoreModule from "ignore"
import type { Ignore } from "ignore"

// Handle CJS/ESM interop - at runtime this will be the function
const createIgnore = ignoreModule as unknown as (options?: { ignorecase?: boolean }) => Ignore

/**
 * Directories that should always be ignored
 */
const ALWAYS_IGNORED_DIRS = [
	"node_modules",
	".git",
	".svn",
	".hg",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".tox",
	".venv",
	"venv",
	".env",
	"env",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".cache",
	"coverage",
	".nyc_output",
	".idea",
	".vscode",
	".vs",
	"vendor",
	"target",
	"bin",
	"obj",
]

/**
 * Check if a path is in an ignored directory
 */
export function isPathInIgnoredDirectory(relativePath: string): boolean {
	const normalizedPath = relativePath.replace(/\\/g, "/")
	const parts = normalizedPath.split("/")

	for (const part of parts) {
		if (ALWAYS_IGNORED_DIRS.includes(part)) {
			return true
		}
	}

	return false
}

/**
 * Read .cs-mcp-include file and parse extensions
 * Returns array of extensions (with leading dot, lowercase)
 */
export async function readIncludeFile(folderPath: string): Promise<string[] | null> {
	const includePath = path.join(folderPath, ".cs-mcp-include")
	try {
		const content = await fs.readFile(includePath, "utf-8")
		// Parse lines, filter comments and empty lines
		const extensions = content
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line && !line.startsWith("#"))
			.map(ext => {
				// Normalize: ensure leading dot and lowercase
				const normalized = ext.toLowerCase()
				return normalized.startsWith('.') ? normalized : `.${normalized}`
			})
		
		return extensions.length > 0 ? extensions : null
	} catch {
		// .cs-mcp-include doesn't exist
		return null
	}
}

/**
 * Merge programmatic includeExtensions with .cs-mcp-include file
 * Programmatic extensions take precedence if specified
 */
export async function resolveIncludeExtensions(
	folderPath: string,
	programmaticExtensions?: string[]
): Promise<string[] | undefined> {
	// If programmatic extensions specified, use them
	if (programmaticExtensions && programmaticExtensions.length > 0) {
		return programmaticExtensions
	}

	// Otherwise, try to read from .cs-mcp-include file
	const fileExtensions = await readIncludeFile(folderPath)
	return fileExtensions || undefined
}

/**
 * Create an ignore instance from .gitignore file
 */
export async function createIgnoreFromGitignore(folderPath: string): Promise<Ignore> {
	const ig = createIgnore()

	// Add always-ignored directories
	ALWAYS_IGNORED_DIRS.forEach((dir) => {
		ig.add(dir)
		ig.add(`${dir}/`)
	})

	// Try to read .gitignore
	const gitignorePath = path.join(folderPath, ".gitignore")
	try {
		const content = await fs.readFile(gitignorePath, "utf-8")
		ig.add(content)
	} catch {
		// .gitignore doesn't exist, that's fine
	}

	// Try to read .cs-mcp-ignore if it exists
	const rooignorePath = path.join(folderPath, ".cs-mcp-ignore")
	try {
		const content = await fs.readFile(rooignorePath, "utf-8")
		ig.add(content)
	} catch {
		// .cs-mcp-ignore doesn't exist, that's fine
	}

	return ig
}

/**
 * Filter paths using an ignore instance
 */
export function filterPathsWithIgnore(paths: string[], basePath: string, ig: Ignore): string[] {
	return paths.filter((fullPath) => {
		const relativePath = path.relative(basePath, fullPath).replace(/\\/g, "/")
		return !ig.ignores(relativePath) && !isPathInIgnoredDirectory(relativePath)
	})
}
