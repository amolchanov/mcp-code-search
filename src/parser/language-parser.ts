import * as path from "path"
import Parser from "web-tree-sitter"

export interface LanguageParser {
	[key: string]: {
		parser: Parser
		query: Parser.Query
	}
}

let isParserInitialized = false

async function loadLanguage(langName: string, sourceDirectory?: string): Promise<Parser.Language> {
	const baseDir = sourceDirectory || path.join(process.cwd(), "wasm")
	const wasmPath = path.join(baseDir, `tree-sitter-${langName}.wasm`)

	try {
		return await Parser.Language.load(wasmPath)
	} catch (error) {
		console.error(`Error loading language: ${wasmPath}: ${error instanceof Error ? error.message : error}`)
		throw error
	}
}

// Query strings for different languages
const javascriptQuery = `
(function_declaration name: (identifier) @name.definition.function) @definition.function
(class_declaration name: (identifier) @name.definition.class) @definition.class
(method_definition name: (property_identifier) @name.definition.method) @definition.method
(export_statement (function_declaration name: (identifier) @name.definition.function)) @definition.function
(export_statement (class_declaration name: (identifier) @name.definition.class)) @definition.class
`

const typescriptQuery = `
(function_declaration name: (identifier) @name.definition.function) @definition.function
(class_declaration name: (type_identifier) @name.definition.class) @definition.class
(method_definition name: (property_identifier) @name.definition.method) @definition.method
(interface_declaration name: (type_identifier) @name.definition.interface) @definition.interface
(type_alias_declaration name: (type_identifier) @name.definition.type) @definition.type
(export_statement (function_declaration name: (identifier) @name.definition.function)) @definition.function
(export_statement (class_declaration name: (type_identifier) @name.definition.class)) @definition.class
`

const pythonQuery = `
(function_definition name: (identifier) @name.definition.function) @definition.function
(class_definition name: (identifier) @name.definition.class) @definition.class
`

const rustQuery = `
(function_item name: (identifier) @name.definition.function) @definition.function
(struct_item name: (type_identifier) @name.definition.struct) @definition.struct
(impl_item type: (type_identifier) @name.definition.impl) @definition.impl
(trait_item name: (type_identifier) @name.definition.trait) @definition.trait
(enum_item name: (type_identifier) @name.definition.enum) @definition.enum
`

const goQuery = `
(function_declaration name: (identifier) @name.definition.function) @definition.function
(method_declaration name: (field_identifier) @name.definition.method) @definition.method
(type_declaration (type_spec name: (type_identifier) @name.definition.type)) @definition.type
`

const cppQuery = `
(function_definition declarator: (function_declarator declarator: (identifier) @name.definition.function)) @definition.function
(class_specifier name: (type_identifier) @name.definition.class) @definition.class
`

const cQuery = `
(function_definition declarator: (function_declarator declarator: (identifier) @name.definition.function)) @definition.function
(struct_specifier name: (type_identifier) @name.definition.struct) @definition.struct
`

const csharpQuery = `
(method_declaration name: (identifier) @name.definition.method) @definition.method
(class_declaration name: (identifier) @name.definition.class) @definition.class
(interface_declaration name: (identifier) @name.definition.interface) @definition.interface
`

const rubyQuery = `
(method name: (identifier) @name.definition.method) @definition.method
(class name: (constant) @name.definition.class) @definition.class
(module name: (constant) @name.definition.module) @definition.module
`

const javaQuery = `
(method_declaration name: (identifier) @name.definition.method) @definition.method
(class_declaration name: (identifier) @name.definition.class) @definition.class
(interface_declaration name: (identifier) @name.definition.interface) @definition.interface
`

const phpQuery = `
(function_definition name: (name) @name.definition.function) @definition.function
(class_declaration name: (name) @name.definition.class) @definition.class
(method_declaration name: (name) @name.definition.method) @definition.method
`

const htmlQuery = `
(element (start_tag (tag_name) @name.definition.tag)) @definition.tag
`

const swiftQuery = `
(function_declaration name: (simple_identifier) @name.definition.function) @definition.function
(class_declaration name: (type_identifier) @name.definition.class) @definition.class
`

const kotlinQuery = `
(function_declaration (simple_identifier) @name.definition.function) @definition.function
(class_declaration (type_identifier) @name.definition.class) @definition.class
`

const cssQuery = `
(rule_set (selectors) @name.definition.selector) @definition.selector
`

const ocamlQuery = `
(value_definition (let_binding pattern: (value_name) @name.definition.function)) @definition.function
`

const solidityQuery = `
(function_definition name: (identifier) @name.definition.function) @definition.function
(contract_declaration name: (identifier) @name.definition.contract) @definition.contract
`

const tomlQuery = `
(table (bare_key) @name.definition.table) @definition.table
`

const vueQuery = `
(element (start_tag (tag_name) @name.definition.tag)) @definition.tag
`

const luaQuery = `
(function_declaration name: (identifier) @name.definition.function) @definition.function
`

const systemrdlQuery = `
(component_definition (component_type) @name.definition.component) @definition.component
`

const tlaPlusQuery = `
(module (identifier) @name.definition.module) @definition.module
`

const zigQuery = `
(function_declaration name: (identifier) @name.definition.function) @definition.function
`

const embeddedTemplateQuery = `
(directive) @definition.directive
`

const elispQuery = `
(function_definition name: (symbol) @name.definition.function) @definition.function
`

const elixirQuery = `
(call target: (identifier) @name.definition.function) @definition.function
`

/**
 * Load language parsers for the given file extensions
 */
export async function loadRequiredLanguageParsers(filesToParse: string[], sourceDirectory?: string): Promise<LanguageParser> {
	if (!isParserInitialized) {
		try {
			await Parser.init()
			isParserInitialized = true
		} catch (error) {
			console.error(`Error initializing parser: ${error instanceof Error ? error.message : error}`)
			throw error
		}
	}

	const extensionsToLoad = new Set(filesToParse.map((file) => path.extname(file).toLowerCase().slice(1)))
	const parsers: LanguageParser = {}

	for (const ext of extensionsToLoad) {
		let language: Parser.Language
		let queryString: string
		let parserKey = ext

		try {
			switch (ext) {
				case "js":
				case "jsx":
				case "json":
					language = await loadLanguage("javascript", sourceDirectory)
					queryString = javascriptQuery
					break
				case "ts":
					language = await loadLanguage("typescript", sourceDirectory)
					queryString = typescriptQuery
					break
				case "tsx":
					language = await loadLanguage("tsx", sourceDirectory)
					queryString = typescriptQuery
					break
				case "py":
					language = await loadLanguage("python", sourceDirectory)
					queryString = pythonQuery
					break
				case "rs":
					language = await loadLanguage("rust", sourceDirectory)
					queryString = rustQuery
					break
				case "go":
					language = await loadLanguage("go", sourceDirectory)
					queryString = goQuery
					break
				case "cpp":
				case "hpp":
					language = await loadLanguage("cpp", sourceDirectory)
					queryString = cppQuery
					break
				case "c":
				case "h":
					language = await loadLanguage("c", sourceDirectory)
					queryString = cQuery
					break
				case "cs":
					language = await loadLanguage("c_sharp", sourceDirectory)
					queryString = csharpQuery
					break
				case "rb":
					language = await loadLanguage("ruby", sourceDirectory)
					queryString = rubyQuery
					break
				case "java":
					language = await loadLanguage("java", sourceDirectory)
					queryString = javaQuery
					break
				case "php":
					language = await loadLanguage("php", sourceDirectory)
					queryString = phpQuery
					break
				case "swift":
					language = await loadLanguage("swift", sourceDirectory)
					queryString = swiftQuery
					break
				case "kt":
				case "kts":
					language = await loadLanguage("kotlin", sourceDirectory)
					queryString = kotlinQuery
					break
				case "css":
					language = await loadLanguage("css", sourceDirectory)
					queryString = cssQuery
					break
				case "html":
				case "htm":
					language = await loadLanguage("html", sourceDirectory)
					queryString = htmlQuery
					break
				case "ml":
				case "mli":
					language = await loadLanguage("ocaml", sourceDirectory)
					queryString = ocamlQuery
					break
				case "scala":
					language = await loadLanguage("scala", sourceDirectory)
					queryString = luaQuery
					break
				case "sol":
					language = await loadLanguage("solidity", sourceDirectory)
					queryString = solidityQuery
					break
				case "toml":
					language = await loadLanguage("toml", sourceDirectory)
					queryString = tomlQuery
					break
				case "vue":
					language = await loadLanguage("vue", sourceDirectory)
					queryString = vueQuery
					break
				case "lua":
					language = await loadLanguage("lua", sourceDirectory)
					queryString = luaQuery
					break
				case "rdl":
					language = await loadLanguage("systemrdl", sourceDirectory)
					queryString = systemrdlQuery
					break
				case "tla":
					language = await loadLanguage("tlaplus", sourceDirectory)
					queryString = tlaPlusQuery
					break
				case "zig":
					language = await loadLanguage("zig", sourceDirectory)
					queryString = zigQuery
					break
				case "ejs":
				case "erb":
					parserKey = "embedded_template"
					language = await loadLanguage("embedded_template", sourceDirectory)
					queryString = embeddedTemplateQuery
					break
				case "el":
					language = await loadLanguage("elisp", sourceDirectory)
					queryString = elispQuery
					break
				case "ex":
				case "exs":
					language = await loadLanguage("elixir", sourceDirectory)
					queryString = elixirQuery
					break
				default:
					console.warn(`Unsupported language extension: ${ext}`)
					continue
			}

			const parser = new Parser()
			parser.setLanguage(language)
			const query = language.query(queryString)
			parsers[parserKey] = { parser, query }
		} catch (error) {
			console.warn(`Failed to load parser for extension ${ext}:`, error instanceof Error ? error.message : error)
		}
	}

	return parsers
}
