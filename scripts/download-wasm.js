#!/usr/bin/env node

import * as fs from "fs/promises"
import * as path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const WASM_DIR = path.join(__dirname, "..", "wasm")

// Tree-sitter WASM files from tree-sitter-wasms package
const LANGUAGES = [
	"javascript",
	"typescript",
	"tsx",
	"python",
	"rust",
	"go",
	"cpp",
	"c",
	"c_sharp",
	"ruby",
	"java",
	"php",
	"swift",
	"kotlin",
	"css",
	"html",
	"ocaml",
	"scala",
	"solidity",
	"toml",
	"vue",
	"lua",
	"systemrdl",
	"tlaplus",
	"zig",
	"embedded_template",
	"elisp",
	"elixir",
]

const BASE_URL = "https://unpkg.com/tree-sitter-wasms@latest/out"

async function downloadFile(url, dest) {
	console.log(`Downloading ${url}...`)
	try {
		const response = await fetch(url)
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`)
		}
		const buffer = await response.arrayBuffer()
		await fs.writeFile(dest, Buffer.from(buffer))
		console.log(`  -> ${dest}`)
	} catch (error) {
		console.error(`  Failed to download ${url}: ${error.message}`)
	}
}

async function main() {
	// Ensure wasm directory exists
	await fs.mkdir(WASM_DIR, { recursive: true })

	// Download web-tree-sitter main WASM
	await downloadFile(
		"https://cdn.jsdelivr.net/npm/web-tree-sitter@0.20.8/tree-sitter.wasm",
		path.join(WASM_DIR, "tree-sitter.wasm")
	)

	// Download language WASM files
	for (const lang of LANGUAGES) {
		const filename = `tree-sitter-${lang}.wasm`
		const url = `${BASE_URL}/${filename}`
		const dest = path.join(WASM_DIR, filename)

		await downloadFile(url, dest)
	}

	console.log("\nDone! WASM files downloaded to:", WASM_DIR)
}

main().catch(console.error)
