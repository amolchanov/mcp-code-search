import fetch from "node-fetch"

export interface ToolCallRequest {
	name: string
	arguments: any
}

export interface ToolCallResponse {
	content: Array<{
		type: string
		text: string
	}>
	isError?: boolean
}

export class SSEClient {
	constructor(private baseUrl: string) {}

	async callTool(name: string, args: any): Promise<ToolCallResponse> {
		const url = `${this.baseUrl}/api/mcp/call-tool`

		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name,
					arguments: args,
				}),
			})

			if (!response.ok) {
				const errorText = await response.text()
				throw new Error(`Tool call failed: ${response.status} ${errorText}`)
			}

			return await response.json()
		} catch (error) {
			console.error(`[SSEClient] Tool call failed for ${name}:`, error)
			throw error
		}
	}

	async listTools(): Promise<any> {
		const url = `${this.baseUrl}/api/mcp/list-tools`

		try {
			const response = await fetch(url, {
				method: "GET",
				headers: {
					"Content-Type": "application/json",
				},
			})

			if (!response.ok) {
				const errorText = await response.text()
				throw new Error(`List tools failed: ${response.status} ${errorText}`)
			}

			return await response.json()
		} catch (error) {
			console.error(`[SSEClient] List tools failed:`, error)
			throw error
		}
	}

	async healthCheck(): Promise<boolean> {
		const url = `${this.baseUrl}/health`

		try {
			const response = await fetch(url, {
				method: "GET",
			})

			return response.ok
		} catch (error) {
			return false
		}
	}
}
