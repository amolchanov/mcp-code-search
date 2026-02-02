import { spawn } from "child_process"
import * as path from "path"
import { SSEClient } from "./sse-client.js"

export interface ServerConfig {
	port: number
	host: string
}

export class ServerManager {
	private client: SSEClient
	private baseUrl: string

	constructor(private config: ServerConfig = { port: 3100, host: "localhost" }) {
		this.baseUrl = `http://${config.host}:${config.port}`
		this.client = new SSEClient(this.baseUrl)
	}

	async ensureRunning(): Promise<void> {
		const isRunning = await this.client.healthCheck()

		if (isRunning) {
			console.error("[ServerManager] SSE server already running")
			return
		}

		console.error("[ServerManager] SSE server not running, starting it...")
		await this.startServer()
	}

	private async startServer(): Promise<void> {
		// Get the path to the compiled index.js
		const indexPath = path.join(process.cwd(), "dist", "index.js")

		console.error(`[ServerManager] Starting SSE server: node ${indexPath} --sse`)

		// Spawn detached background process
		const child = spawn("node", [indexPath, "--sse", "--port", String(this.config.port)], {
			detached: true,
			stdio: "ignore", // Ignore stdio to fully detach
			windowsHide: true,
		})

		// Unref so parent can exit
		child.unref()

		console.error(`[ServerManager] SSE server started with PID ${child.pid}`)

		// Wait for server to be ready
		await this.waitForServer()
	}

	private async waitForServer(maxWaitMs: number = 30000): Promise<void> {
		const startTime = Date.now()
		const checkInterval = 500

		while (Date.now() - startTime < maxWaitMs) {
			const isReady = await this.client.healthCheck()

			if (isReady) {
				console.error(`[ServerManager] SSE server is ready at ${this.baseUrl}`)
				return
			}

			// Wait before next check
			await new Promise((resolve) => setTimeout(resolve, checkInterval))
		}

		throw new Error(`SSE server failed to start within ${maxWaitMs}ms`)
	}

	getClient(): SSEClient {
		return this.client
	}

	getBaseUrl(): string {
		return this.baseUrl
	}
}
