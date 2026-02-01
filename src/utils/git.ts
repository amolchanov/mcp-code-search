import { exec } from "child_process"
import { promisify } from "util"
import * as path from "path"
import * as fs from "fs/promises"

const execAsync = promisify(exec)

/**
 * Result of git worktree detection
 */
export interface WorktreeInfo {
	isWorktree: boolean
	/** Path to the common .git directory (shared by all worktrees) */
	gitCommonDir?: string
	/** Path to the main repository folder (parent of .git) */
	mainRepoPath?: string
	/** Current branch name */
	branch?: string
}

/**
 * Execute a git command in a directory
 */
async function gitExec(cwd: string, args: string): Promise<string | null> {
	try {
		const { stdout } = await execAsync(`git ${args}`, {
			cwd,
			timeout: 5000,
			windowsHide: true,
		})
		return stdout.trim()
	} catch {
		return null
	}
}

/**
 * Check if a folder exists
 */
export async function folderExists(folderPath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(folderPath)
		return stat.isDirectory()
	} catch {
		return false
	}
}

/**
 * Check if a folder is a git repository (regular or worktree)
 */
export async function isGitRepository(folderPath: string): Promise<boolean> {
	const result = await gitExec(folderPath, "rev-parse --git-dir")
	return result !== null
}

/**
 * Get the common .git directory path
 * For regular repos, this is <repo>/.git
 * For worktrees, this points to the main repo's .git
 */
export async function getGitCommonDir(folderPath: string): Promise<string | null> {
	const result = await gitExec(folderPath, "rev-parse --git-common-dir")
	if (!result) return null

	// Result may be relative, resolve to absolute
	const absolutePath = path.isAbsolute(result)
		? result
		: path.resolve(folderPath, result)

	return path.normalize(absolutePath)
}

/**
 * Get the .git directory for this specific worktree/repo
 * For regular repos, same as common dir
 * For worktrees, this is the worktree-specific .git file location
 */
export async function getGitDir(folderPath: string): Promise<string | null> {
	const result = await gitExec(folderPath, "rev-parse --git-dir")
	if (!result) return null

	const absolutePath = path.isAbsolute(result)
		? result
		: path.resolve(folderPath, result)

	return path.normalize(absolutePath)
}

/**
 * Detect if a folder is a git worktree and get its info
 */
export async function getWorktreeInfo(folderPath: string): Promise<WorktreeInfo> {
	const gitDir = await getGitDir(folderPath)
	const gitCommonDir = await getGitCommonDir(folderPath)

	if (!gitDir || !gitCommonDir) {
		return { isWorktree: false }
	}

	// Normalize paths for comparison
	const normalizedGitDir = path.normalize(gitDir)
	const normalizedCommonDir = path.normalize(gitCommonDir)

	// If git-dir and git-common-dir are different, it's a worktree
	const isWorktree = normalizedGitDir !== normalizedCommonDir

	// Get main repo path (parent of .git common dir)
	const mainRepoPath = path.dirname(normalizedCommonDir)

	// Get current branch
	const branch = await gitExec(folderPath, "rev-parse --abbrev-ref HEAD")

	return {
		isWorktree,
		gitCommonDir: normalizedCommonDir,
		mainRepoPath: isWorktree ? mainRepoPath : undefined,
		branch: branch ?? undefined,
	}
}

/**
 * List all worktrees for a repository
 */
export async function listWorktrees(folderPath: string): Promise<WorktreeListItem[]> {
	const result = await gitExec(folderPath, "worktree list --porcelain")
	if (!result) return []

	const worktrees: WorktreeListItem[] = []
	let current: Partial<WorktreeListItem> = {}

	for (const line of result.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current.path) {
				worktrees.push(current as WorktreeListItem)
			}
			current = { path: line.slice(9) }
		} else if (line.startsWith("HEAD ")) {
			current.head = line.slice(5)
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice(7)
		} else if (line === "bare") {
			current.isBare = true
		} else if (line === "detached") {
			current.isDetached = true
		}
	}

	if (current.path) {
		worktrees.push(current as WorktreeListItem)
	}

	return worktrees
}

export interface WorktreeListItem {
	/** Absolute path to worktree folder */
	path: string
	/** HEAD commit hash */
	head?: string
	/** Branch ref (e.g., refs/heads/main) */
	branch?: string
	/** True if this is a bare repository */
	isBare?: boolean
	/** True if HEAD is detached */
	isDetached?: boolean
}

/**
 * Get modified and untracked files in a worktree (relative to HEAD)
 * These are the files that differ from the committed state
 */
export async function getWorktreeChangedFiles(folderPath: string): Promise<string[]> {
	const files: string[] = []

	// Get modified files (staged and unstaged)
	const modified = await gitExec(folderPath, "diff --name-only HEAD")
	if (modified) {
		files.push(...modified.split("\n").filter(Boolean))
	}

	// Get untracked files
	const untracked = await gitExec(folderPath, "ls-files --others --exclude-standard")
	if (untracked) {
		files.push(...untracked.split("\n").filter(Boolean))
	}

	// Dedupe and return
	return [...new Set(files)]
}

/**
 * Find indexed folders that no longer exist on disk
 */
export async function findOrphanedPaths(paths: string[]): Promise<string[]> {
	const orphaned: string[] = []

	for (const p of paths) {
		if (!(await folderExists(p))) {
			orphaned.push(p)
		}
	}

	return orphaned
}

/**
 * Check if two paths are part of the same git repository
 * (either same repo or worktrees of the same repo)
 */
export async function isSameRepository(path1: string, path2: string): Promise<boolean> {
	const commonDir1 = await getGitCommonDir(path1)
	const commonDir2 = await getGitCommonDir(path2)

	if (!commonDir1 || !commonDir2) {
		return false
	}

	return path.normalize(commonDir1) === path.normalize(commonDir2)
}
