#!/usr/bin/env node

import { CodeSearchServer } from "./server.js"

function parseIndexPaths(args: string[]): string[] {
	const paths: string[] = []
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--index" && args[i + 1]) {
			paths.push(args[i + 1])
			i++
		}
	}
	// Also check environment variable (comma-separated paths)
	const envPaths = process.env.CODE_SEARCH_FOLDERS
	if (envPaths) {
		paths.push(...envPaths.split(",").map(p => p.trim()).filter(Boolean))
	}
	return paths
}

async function main() {
	const args = process.argv.slice(2)
	const mode = args.includes("--sse") ? "sse" : "stdio"
	const portIndex = args.indexOf("--port")
	const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3100
	const useTray = args.includes("--tray")
	const autoIndexPaths = parseIndexPaths(args)

	const server = new CodeSearchServer()

	// Handle graceful shutdown
	const shutdown = async () => {
		console.error("[CodeSearch] Shutting down...")
		await server.shutdown()
		process.exit(0)
	}

	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)

	try {
		await server.run(mode, port, useTray, autoIndexPaths)
	} catch (error) {
		console.error("[CodeSearch] Fatal error:", error)
		process.exit(1)
	}
}

main()
