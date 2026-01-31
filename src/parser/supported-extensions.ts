/**
 * Supported file extensions for code indexing
 */
export const extensions = [
	".tla",
	".js",
	".jsx",
	".ts",
	".vue",
	".tsx",
	".py",
	".rs",
	".go",
	".c",
	".h",
	".cpp",
	".hpp",
	".cs",
	".rb",
	".java",
	".php",
	".swift",
	".sol",
	".kt",
	".kts",
	".ex",
	".exs",
	".el",
	".html",
	".htm",
	".md",
	".markdown",
	".json",
	".css",
	".rdl",
	".ml",
	".mli",
	".lua",
	".scala",
	".toml",
	".zig",
	".elm",
	".ejs",
	".erb",
	".vb",
]

export const scannerExtensions = extensions

/**
 * Extensions that should always use fallback chunking instead of tree-sitter parsing
 */
export const fallbackExtensions = [
	".vb",
	".scala",
	".swift",
]

/**
 * Check if a file extension should use fallback chunking
 */
export function shouldUseFallbackChunking(extension: string): boolean {
	return fallbackExtensions.includes(extension.toLowerCase())
}

/**
 * Get file extension from path
 */
export function getExtension(filePath: string): string {
	const lastDot = filePath.lastIndexOf(".")
	if (lastDot === -1) return ""
	return filePath.substring(lastDot).toLowerCase()
}

/**
 * Check if file extension is supported
 */
export function isSupportedExtension(extension: string): boolean {
	return scannerExtensions.includes(extension.toLowerCase())
}
