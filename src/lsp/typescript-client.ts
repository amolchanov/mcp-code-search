import { LSPClientBase } from "./lsp-client-base.js"
import * as path from "path"

/**
 * LSP client for TypeScript and JavaScript
 * Uses typescript-language-server
 */
export class TypeScriptLSPClient extends LSPClientBase {
	readonly languageId = "typescript"

	getServerCommand(): { command: string; args: string[] } {
		return {
			command: "typescript-language-server",
			args: ["--stdio"],
		}
	}

	getLanguageId(filePath: string): string {
		const ext = path.extname(filePath).toLowerCase()
		switch (ext) {
			case ".tsx":
				return "typescriptreact"
			case ".jsx":
				return "javascriptreact"
			case ".js":
			case ".mjs":
			case ".cjs":
				return "javascript"
			default:
				return "typescript"
		}
	}

	/**
	 * Extract TypeScript-specific type information from hover
	 */
	protected extractTypeAndDocs(text: string): {
		typeSignature?: string
		documentation?: string
	} {
		// TypeScript hover format often looks like:
		// ```typescript
		// (method) ClassName.methodName(param: Type): ReturnType
		// ```
		// Documentation text here

		let typeSignature: string | undefined
		let documentation: string | undefined

		// Extract code blocks (type signature)
		const codeBlockMatch = text.match(/```(?:typescript|javascript|ts|js)?\n?([\s\S]*?)```/)
		if (codeBlockMatch) {
			typeSignature = codeBlockMatch[1].trim()

			// Clean up common prefixes
			typeSignature = typeSignature
				.replace(/^\(method\)\s*/, "")
				.replace(/^\(property\)\s*/, "")
				.replace(/^\(function\)\s*/, "")
				.replace(/^\(alias\)\s*/, "")
				.replace(/^\(type alias\)\s*/, "")
				.replace(/^\(interface\)\s*/, "")
				.replace(/^\(class\)\s*/, "")
				.replace(/^\(const\)\s*/, "")
				.replace(/^\(let\)\s*/, "")
				.replace(/^\(var\)\s*/, "")
				.trim()
		}

		// Extract documentation (everything outside code blocks)
		const docText = text
			.replace(/```(?:typescript|javascript|ts|js)?\n?[\s\S]*?```/g, "")
			.trim()

		if (docText) {
			// Clean up common patterns
			documentation = docText
				.replace(/^---\s*/gm, "") // Remove horizontal rules
				.replace(/\n{3,}/g, "\n\n") // Normalize multiple newlines
				.trim()

			if (!documentation) documentation = undefined
		}

		return { typeSignature, documentation }
	}
}
