import { LSPClientBase } from "./lsp-client-base.js"

/**
 * LSP client for C#
 * Uses csharp-ls (lightweight) or OmniSharp (full-featured)
 */
export class CSharpLSPClient extends LSPClientBase {
	readonly languageId = "csharp"

	constructor(private readonly useOmniSharp: boolean = false) {
		super()
	}

	getServerCommand(): { command: string; args: string[] } {
		if (this.useOmniSharp) {
			// OmniSharp - more features but heavier
			return {
				command: "OmniSharp",
				args: ["-lsp", "--encoding", "utf-8"],
			}
		}

		// csharp-ls - lightweight alternative
		return {
			command: "csharp-ls",
			args: [],
		}
	}

	getLanguageId(_filePath: string): string {
		return "csharp"
	}

	/**
	 * Extract C#-specific type information from hover
	 */
	protected extractTypeAndDocs(text: string): {
		typeSignature?: string
		documentation?: string
	} {
		// C# hover format often looks like:
		// ```csharp
		// public async Task<Result> ProcessAsync(User user)
		// ```
		// <summary>
		// Documentation here
		// </summary>

		let typeSignature: string | undefined
		let documentation: string | undefined

		// Extract code blocks (type signature)
		const codeBlockMatch = text.match(/```(?:csharp|cs|c#)?\n?([\s\S]*?)```/)
		if (codeBlockMatch) {
			typeSignature = codeBlockMatch[1].trim()
		}

		// Extract documentation
		let docText = text
			.replace(/```(?:csharp|cs|c#)?\n?[\s\S]*?```/g, "")
			.trim()

		if (docText) {
			// Clean up XML documentation tags
			docText = docText
				.replace(/<summary>\s*/gi, "")
				.replace(/<\/summary>\s*/gi, "")
				.replace(/<param\s+name="([^"]+)">\s*/gi, "@param $1 - ")
				.replace(/<\/param>\s*/gi, "")
				.replace(/<returns>\s*/gi, "@returns ")
				.replace(/<\/returns>\s*/gi, "")
				.replace(/<remarks>\s*/gi, "")
				.replace(/<\/remarks>\s*/gi, "")
				.replace(/<exception\s+cref="([^"]+)">\s*/gi, "@throws $1 - ")
				.replace(/<\/exception>\s*/gi, "")
				.replace(/<see\s+cref="([^"]+)"\s*\/>/gi, "$1")
				.replace(/<c>/gi, "`")
				.replace(/<\/c>/gi, "`")
				.replace(/<code>/gi, "```")
				.replace(/<\/code>/gi, "```")
				.replace(/\n{3,}/g, "\n\n")
				.trim()

			if (docText) {
				documentation = docText
			}
		}

		return { typeSignature, documentation }
	}
}
