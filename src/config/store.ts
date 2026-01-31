import * as fs from "fs/promises"
import * as path from "path"
import { ServerConfigSchema, FoldersConfigSchema, ServerConfigOutput, FoldersConfigOutput, IndexedFolderOutput } from "./schema.js"

const DATA_DIR = path.join(process.cwd(), "data")
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
	const existing = config.folders.find((f) => f.path === folder.path)
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
 * Get a folder by path
 */
export async function getFolderByPath(folderPath: string): Promise<IndexedFolderOutput | undefined> {
	const config = await loadFoldersConfig()
	const normalizedPath = path.normalize(folderPath)
	return config.folders.find((f) => path.normalize(f.path) === normalizedPath)
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
