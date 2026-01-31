import pkg from "systray2"
const SysTray = pkg.default || pkg
type SysTrayInstance = InstanceType<typeof SysTray>

interface ClickEvent {
	type: "clicked"
	item: { title: string; tooltip: string; enabled?: boolean }
	seq_id: number
}

// Simple 16x16 icon (magnifying glass) as base64 ICO
const TRAY_ICON = `AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAAAQAABILAAASCwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACMjIwAjo6OPY6OjmmOjo5pjo6OPYyMjAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjnOQAI5zkSyOc5JkjnOTRI5zk0SOc5JkjnORLI5zkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACODwAAjg8AAI4PAqSODwdYjg8JBI4PCriODwv4jg8L+I4PCriODwdYjg8CpI4PAAAAAAAAAAAAAAAAAAAAAAAAAAAAjg8AAI4PBGSODwnQI5zkzyOc5P8jnOT/I5zk/yOc5P8jnOTPjg8J0I4PBGQAAAAAAAAAAAAAAAAAAAAAAAAAAI4PA1iODwvMI5zk/yOc5P8jnOT/I5zk/yOc5P8jnOT/I5zk/yOc5MyODwtYAAAAAAAAAAAAAAAAAAAAACOc5AAjnORMI5zk6iOc5P8jnOT/I5zk/yOc5P8jnOT/I5zk/yOc5P8jnOT/I5zk6iOc5EwjnOQAAAAAAAAAAAAAAAAAI5zkSSOc5OgjnOT/I5zk/yOc5P8jnOT/I5zk/yOc5P8jnOT/I5zk/yOc5P8jnOToI5zkSQAAAAAAAAAAAAAAAAjg8CYjnOTmI5zk/yOc5P8jnOT/I5zk/yOc5P8jnOT/I5zk/yOc5P8jnOT/I5zk5gjg8CYAAAAAAAAAAAAAAAAAI4PAqCOc5P8jnOT/I5zk/yOc5P8jnOT/I5zk/yOc5P8jnOT/I5zk/yOc5P+ODwKgAAAAAAAAAAAAAAAAAAAAACODwKgjnOT/I5zk/yOc5P8jnOT/I5zk/yOc5P8jnOT/I5zk/yOc5P8jg8CoAAAAAAAAAAAAAAAAAAAAAAAAAAAI4PAqCOc5P8jnOT/I5zk/yOc5P8jnOT/I5zk/yOc5P8jnOT/CODwKgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjg8CmI5zk5yOc5P8jnOT/I5zk/yOc5P8jnOT/I5zk5yODwKYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI5zkACOc5EkjnOToI5zk/yOc5P8jnOT/I5zk6COc5EkjnOQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACODwAAI5zkTCOc5OojnOT/I5zk6iOc5EyODwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjnOQAI5zkSyOc5EsjnOQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/n8AAPgfAADwDwAAwAMAAIABAACAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAAgAEAAMADAADwDwAA+B8AAA==`

export interface TrayCallbacks {
	onStop: () => void
}

export class SystemTray {
	private systray: SysTrayInstance | null = null
	private port: number
	private callbacks: TrayCallbacks

	constructor(port: number, callbacks: TrayCallbacks) {
		this.port = port
		this.callbacks = callbacks
	}

	start(): void {
		this.systray = new SysTray({
			menu: {
				icon: TRAY_ICON,
				title: "",
				tooltip: `Code Search MCP (port ${this.port})`,
				items: [
					{
						title: `Code Search Server`,
						tooltip: `Running on port ${this.port}`,
						enabled: false,
					},
					{
						title: `Port: ${this.port}`,
						tooltip: "Server port",
						enabled: false,
					},
					SysTray.separator,
					{
						title: "Open Admin UI",
						tooltip: "Open admin dashboard in browser",
						enabled: true,
					},
					{
						title: "Open Health Check",
						tooltip: "Open health endpoint in browser",
						enabled: true,
					},
					SysTray.separator,
					{
						title: "Stop Server",
						tooltip: "Stop the server and exit",
						enabled: true,
					},
				],
			},
			debug: false,
			copyDir: true,
		})

		this.systray.onClick((action: ClickEvent) => {
			switch (action.seq_id) {
				case 3: // Open Admin UI
					this.openBrowser(`http://localhost:${this.port}/admin`)
					break
				case 4: // Open Health Check
					this.openBrowser(`http://localhost:${this.port}/health`)
					break
				case 6: // Stop Server
					this.callbacks.onStop()
					break
			}
		})
	}

	private openBrowser(url: string): void {
		const { exec } = require("child_process")
		const command = process.platform === "win32"
			? `start ${url}`
			: process.platform === "darwin"
			? `open ${url}`
			: `xdg-open ${url}`
		exec(command)
	}

	async stop(): Promise<void> {
		if (this.systray) {
			this.systray.kill(false)
			this.systray = null
		}
	}
}
