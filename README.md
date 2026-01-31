# Code Search MCP Server

An MCP (Model Context Protocol) server for semantic code search using vector embeddings. Index your code folders and perform semantic searches to find code by meaning, not just keywords.

## Features

- **Multi-folder support**: Index multiple code folders simultaneously
- **Semantic search**: Find code by meaning, not just keywords
- **Continuous file watching**: Automatically re-indexes files when they change
- **Multiple embedding providers**: OpenAI, Ollama, Gemini, Mistral, Bedrock, OpenRouter
- **Admin UI**: Web dashboard to monitor queries and indexing progress
- **35+ language support**: JavaScript, TypeScript, Python, Rust, Go, and more

## Prerequisites

- Node.js 18+
- Qdrant vector database (local or cloud)
- An embedding provider (Ollama for local, or API keys for cloud providers)

## Installation

```bash
# Clone the repository
git clone https://github.com/amolchanov/mcp-code-search.git
cd mcp-code-search

# Install dependencies
npm install

# Download tree-sitter WASM files
npm run download-wasm

# Build the project
npm run build
```

## Running Qdrant

For local development, run Qdrant using Docker:

```bash
docker run -p 6333:6333 qdrant/qdrant
```

Or install Qdrant locally following the [official guide](https://qdrant.tech/documentation/quick-start/).

## Running Ollama (Optional)

If using Ollama for embeddings:

```bash
# Install Ollama from https://ollama.ai
# Then pull the embedding model
ollama pull nomic-embed-text
```

---

## Integration with Claude Code CLI

### Step 1: Add MCP Server Configuration

Add this to your Claude Code MCP settings file (`~/.claude/claude_code_config.json`):

```json
{
  "mcpServers": {
    "code-search": {
      "command": "node",
      "args": ["/path/to/code-search-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

**Windows example:**
```json
{
  "mcpServers": {
    "code-search": {
      "command": "node",
      "args": ["C:/repos/code-search-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

### Step 2: Add Instructions for Claude Code

Add this to your Claude Code instructions file (`~/.claude/CLAUDE.md`) to help Claude use the search effectively:

```markdown
## Code Search MCP Server

You have access to a semantic code search server via MCP. Use it to find relevant code across indexed repositories.

### Available Tools

- `search` - Search for code semantically
  - query: Natural language description of what you're looking for
  - folderPath: (optional) Limit search to a specific folder
  - maxResults: (optional) Number of results (default: 10)

- `add_folder` - Index a new folder for searching
  - path: Absolute path to the folder

- `list_folders` - See all indexed folders and their status

- `get_status` - Check indexing progress

### When to Use

- Use `search` when looking for code that implements specific functionality
- Use `search` before writing new code to find existing patterns
- Use `search` to find where certain concepts are implemented

### Example Queries

- "authentication middleware that validates JWT tokens"
- "database connection pooling implementation"
- "error handling for API requests"
- "React component that renders a data table"
```

---

## Integration with GitHub Copilot CLI

### Step 1: Add MCP Server Configuration

Add this to your Copilot CLI MCP settings file (`~/.config/github-copilot/config.json` or platform equivalent):

```json
{
  "mcpServers": {
    "code-search": {
      "command": "node",
      "args": ["/path/to/code-search-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

### Step 2: Add Instructions for Copilot

Add this to your Copilot instructions file to help it use the search effectively:

```markdown
## Code Search Integration

A semantic code search server is available for finding code across indexed repositories.

### Tools Available

1. **search** - Find code by semantic meaning
   - Use natural language queries
   - Example: search({ query: "function that parses CSV files" })

2. **add_folder** - Add a repository to the search index
   - Example: add_folder({ path: "/home/user/projects/myapp" })

3. **list_folders** - View indexed repositories

4. **get_status** - Check indexing status

### Best Practices

- Search before implementing new features to find existing code
- Use descriptive queries: "retry logic with exponential backoff" not "retry"
- Search for patterns: "singleton pattern implementation"
- Search for specific functionality: "WebSocket connection handler"

### Integration Tips

When asked to implement something:
1. First search for existing implementations
2. Review found code for patterns and conventions
3. Either reuse existing code or follow established patterns
```

---

## Running in SSE Mode (with Admin UI)

For the web-based admin UI, run in SSE mode:

```bash
node dist/index.js --sse --port 3100
```

Then access the admin UI at: `http://localhost:3100/admin`

The admin UI provides:
- Query history with results
- Indexing progress per folder
- Ollama service status and controls

---

## Configuration

Use the `configure` tool to set up the server after connecting.

### Ollama (Local, Free)

```json
{
  "qdrantUrl": "http://localhost:6333",
  "embedderProvider": "ollama",
  "ollamaBaseUrl": "http://localhost:11434",
  "modelId": "nomic-embed-text:latest"
}
```

### OpenAI

```json
{
  "embedderProvider": "openai",
  "openAiApiKey": "sk-...",
  "modelId": "text-embedding-3-small"
}
```

### Other Providers

Supported: `gemini`, `mistral`, `bedrock`, `openrouter`, `openai-compatible`

---

## Available Tools Reference

### Management

| Tool | Description |
|------|-------------|
| `add_folder` | Add a folder to be indexed |
| `remove_folder` | Remove a folder from indexing |
| `list_folders` | List all indexed folders |
| `clear_index` | Clear/rebuild index |

### Search

| Tool | Description |
|------|-------------|
| `search` | Perform semantic code search |

**Search Parameters:**
- `query` (required): Natural language search query
- `folderPath`: Filter to specific folder
- `fileTypes`: Filter by extensions (e.g., `[".ts", ".js"]`)
- `minScore`: Minimum similarity (0-1)
- `maxResults`: Max results to return

### Status

| Tool | Description |
|------|-------------|
| `get_status` | Get indexing status |
| `get_errors` | Get error reports |
| `configure` | Update server configuration |

---

## Supported Languages

JavaScript, TypeScript, TSX, JSX, Python, Rust, Go, C, C++, C#, Java, Ruby, PHP, Swift, Kotlin, Scala, Elixir, Erlang, Haskell, OCaml, Lua, Perl, R, Julia, Dart, Vue, Svelte, HTML, CSS, SCSS, SQL, GraphQL, Markdown, JSON, YAML, TOML, XML, Bash, PowerShell, Dockerfile, Terraform, Solidity, Zig, Nim, and more.

---

## Ignoring Files

The server respects `.gitignore` files in indexed folders. You can also create a `.rooignore` file with additional patterns to exclude.

Always ignored directories:
- `node_modules`, `.git`, `dist`, `build`, `.next`, `.cache`, `coverage`, `.venv`, `vendor`, `target`, etc.

---

## License

MIT License - see [LICENSE](LICENSE) file.

## Third-Party Licenses

See [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) for dependency licenses.
