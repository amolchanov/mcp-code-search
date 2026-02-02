#!/usr/bin/env node

/**
 * Post-install script to check for LSP server dependencies
 * and provide helpful installation instructions
 */

import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const colors = {
	reset: '\x1b[0m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	red: '\x1b[31m',
}

function log(message, color = colors.reset) {
	console.error(`${color}${message}${colors.reset}`)
}

function execCommand(command) {
	try {
		execSync(command, { stdio: 'pipe', encoding: 'utf-8' })
		return true
	} catch {
		return false
	}
}

function checkTypeScriptLSP() {
	// Check if typescript-language-server is in node_modules
	const localTsLsp = join(__dirname, '..', 'node_modules', '.bin', 'typescript-language-server')
	const localTsLspCmd = process.platform === 'win32' ? `${localTsLsp}.cmd` : localTsLsp
	
	if (existsSync(localTsLspCmd)) {
		log('✓ TypeScript LSP installed locally', colors.green)
		return true
	}

	// Check if installed globally
	if (execCommand('typescript-language-server --version')) {
		log('✓ TypeScript LSP installed globally', colors.green)
		return true
	}

	return false
}

function checkCSharpLSP() {
	// Check if csharp-ls is available
	if (execCommand('csharp-ls --version')) {
		log('✓ C# LSP (csharp-ls) installed', colors.green)
		return true
	}

	return false
}

function checkDotNetSDK() {
	try {
		const version = execSync('dotnet --version', { stdio: 'pipe', encoding: 'utf-8' }).trim()
		log(`✓ .NET SDK ${version} installed`, colors.green)
		return true
	} catch {
		return false
	}
}

log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', colors.blue)
log('  Code Search MCP - LSP Dependencies', colors.blue)
log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n', colors.blue)

const tsLspInstalled = checkTypeScriptLSP()
const csharpLspInstalled = checkCSharpLSP()
const dotnetInstalled = checkDotNetSDK()

if (tsLspInstalled && csharpLspInstalled) {
	log('\n✓ All LSP servers are ready!', colors.green)
	log('  LSP enrichment will improve search quality for TypeScript/JavaScript and C# files.\n', colors.green)
} else {
	log('\n⚠ LSP servers are optional but recommended for better search quality', colors.yellow)
	
	if (!tsLspInstalled) {
		log('\n📦 TypeScript/JavaScript LSP not found', colors.yellow)
		log('   Improves search for: .ts, .tsx, .js, .jsx files', colors.reset)
		log('   Install with: npm install -g typescript-language-server typescript', colors.blue)
	}

	if (!csharpLspInstalled) {
		log('\n📦 C# LSP not found', colors.yellow)
		log('   Improves search for: .cs files', colors.reset)
		
		if (dotnetInstalled) {
			log('   Install with: dotnet tool install --global csharp-ls', colors.blue)
		} else {
			log('   Requires .NET SDK: https://dotnet.microsoft.com/download', colors.red)
			log('   Then install: dotnet tool install --global csharp-ls', colors.blue)
		}
	}

	log('\n💡 Without LSP servers:', colors.reset)
	log('   - Code indexing still works normally', colors.reset)
	log('   - Search quality will be slightly lower (no type signatures/docs)', colors.reset)
	log('   - You can install them later and restart the server\n', colors.reset)
}
