import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import { ServerConfigSchema, FoldersConfigSchema, ServerConfigOutput, FoldersConfigOutput, IndexedFolderOutput } from "./schema.js"

// Use platform-appropriate app data folder
function getAppDataDir(): string {
	const platform = process.platform
	if (platform === "win32") {
		// Windows: %LOCALAPPDATA%\code-search or fallback to %APPDATA%
		return path.join(process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir(), "code-search")
	} else if (platform === "darwin") {
		// macOS: ~/Library/Application Support/code-search
		return path.join(os.homedir(), "Library", "Application Support", "code-search")
	} else {
		// Linux/Unix: ~/.local/share/code-search or XDG_DATA_HOME
		return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "code-search")
	}
}

const DATA_DIR = getAppDataDir()
const CONFIG_FILE = path.join(DATA_DIR, "config.json")
const FOLDERS_FILE = path.join(DATA_DIR, "folders.json")

async function ensureDataDir(): Promise<void> {
	try {
		await fs.mkdir(DATA_DIR, { recursive: true })
		await fs.mkdir(path.join(DATA_DIR, "cache"), { recursive: true })
	} catch {
		// Directory may already exist
	}
}

async function readJsonFile<T>(filePath: string, defaultValue: T): Promise<T> {
	try {
		const content = await fs.readFile(filePath, "utf-8")
		return JSON.parse(content) as T
	} catch {
		return defaultValue
	}
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
	await ensureDataDir()
	const tempPath = `${filePath}.tmp`
	await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8")
	await fs.rename(tempPath, filePath)
}

/**
 * Load server configuration from disk
 */
export async function loadServerConfig(): Promise<ServerConfigOutput> {
	const raw = await readJsonFile(CONFIG_FILE, {})
	return ServerConfigSchema.parse(raw)
}

/**
 * Save server configuration to disk
 */
export async function saveServerConfig(config: Partial<ServerConfigOutput>): Promise<ServerConfigOutput> {
	const current = await loadServerConfig()
	const merged = { ...current, ...config }
	const validated = ServerConfigSchema.parse(merged)
	await writeJsonFile(CONFIG_FILE, validated)
	return validated
}

/**
 * Load folders configuration from disk
 */
export async function loadFoldersConfig(): Promise<FoldersConfigOutput> {
	const raw = await readJsonFile(FOLDERS_FILE, { folders: [] })
	return FoldersConfigSchema.parse(raw)
}

/**
 * Save folders configuration to disk
 */
export async function saveFoldersConfig(config: FoldersConfigOutput): Promise<void> {
	const validated = FoldersConfigSchema.parse(config)
	await writeJsonFile(FOLDERS_FILE, validated)
}

/**
 * Add a folder to the configuration
 */
export async function addFolder(folder: IndexedFolderOutput): Promise<void> {
	const config = await loadFoldersConfig()
	const normalizedPath = normalizePathForComparison(folder.path)
	const existing = config.folders.find((f) => normalizePathForComparison(f.path) === normalizedPath)
	if (existing) {
		throw new Error(`Folder already indexed: ${folder.path}`)
	}
	config.folders.push(folder)
	await saveFoldersConfig(config)
}

/**
 * Remove a folder from the configuration
 */
export async function removeFolder(folderId: string): Promise<IndexedFolderOutput | undefined> {
	const config = await loadFoldersConfig()
	const index = config.folders.findIndex((f) => f.id === folderId)
	if (index === -1) {
		return undefined
	}
	const [removed] = config.folders.splice(index, 1)
	await saveFoldersConfig(config)
	return removed
}

/**
 * Update a folder in the configuration
 */
export async function updateFolder(folderId: string, updates: Partial<IndexedFolderOutput>): Promise<IndexedFolderOutput | undefined> {
	const config = await loadFoldersConfig()
	const folder = config.folders.find((f) => f.id === folderId)
	if (!folder) {
		return undefined
	}
	Object.assign(folder, updates)
	await saveFoldersConfig(config)
	return folder
}

/**
 * Get a folder by ID
 */
export async function getFolder(folderId: string): Promise<IndexedFolderOutput | undefined> {
	const config = await loadFoldersConfig()
	return config.folders.find((f) => f.id === folderId)
}

/**
 * Normalize path for comparison (case-insensitive on Windows)
 */
function normalizePathForComparison(p: string): string {
	const normalized = path.normalize(p)
	// Windows paths are case-insensitive
	return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

/**
 * Get a folder by path
 */
export async function getFolderByPath(folderPath: string): Promise<IndexedFolderOutput | undefined> {
	const config = await loadFoldersConfig()
	const normalizedPath = normalizePathForComparison(folderPath)
	return config.folders.find((f) => normalizePathForComparison(f.path) === normalizedPath)
}

/**
 * Get all folders
 */
export async function getAllFolders(): Promise<IndexedFolderOutput[]> {
	const config = await loadFoldersConfig()
	return config.folders
}

/**
 * Get cache file path for a folder
 */
export function getCacheFilePath(folderId: string): string {
	return path.join(DATA_DIR, "cache", `${folderId}.json`)
}

/**
 * Get the data directory path
 */
export function getDataDir(): string {
	return DATA_DIR
}
