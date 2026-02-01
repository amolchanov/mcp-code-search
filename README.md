# Code Search MCP Server

An MCP (Model Context Protocol) server for semantic code search using vector embeddings. Index your code folders and perform semantic searches to find code by meaning, not just keywords.

## Features

- **Multi-folder support**: Index multiple code folders simultaneously
- **Semantic search**: Find code by meaning, not just keywords
- **Continuous file watching**: Automatically re-indexes files when they change
- **Multiple embedding providers**: OpenAI, Ollama, Gemini, Mistral, Bedrock, OpenRouter
- **Admin UI**: Web dashboard to monitor queries and indexing progress
- **35+ language support**: JavaScript, TypeScript, Python, Rust, Go, and more
- **Embedding cache**: SQLite-based caching to avoid redundant API calls
- **LSP enrichment**: Type signatures and documentation via Language Server Protocol
- **Hierarchical context**: Parent class/module context included in embeddings

## Prerequisites

**Required:**
- Node.js 18+
- Qdrant vector database (local or cloud)
- An embedding provider (Ollama for local, or API keys for cloud providers)

**Optional (for LSP enrichment):**
```bash
# TypeScript/JavaScript LSP (improves search quality for TS/JS/TSX/JSX)
npm install -g typescript-language-server typescript

# C# LSP (improves search quality for .cs files)
dotnet tool install --global csharp-ls
```

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

Add this to your Claude Code settings file (`~/.claude.json`) for user-wide access:

```json
{
  "mcpServers": {
    "code-search": {
      "type": "stdio",
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
      "type": "stdio",
      "command": "node",
      "args": ["C:/repos/code-search-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

**Or use the CLI:**
```bash
claude mcp add --transport stdio code-search -- node /path/to/code-search-mcp/dist/index.js
```

**Project-level config:** Add to `.mcp.json` in your project root for team-shared access.

### Step 2: Add Instructions for Claude Code

Copy the example instructions to your Claude Code instructions file to help Claude use the search effectively:

```bash
# Copy to global instructions
cp examples/CLAUDE.md ~/.claude/CLAUDE.md

# Or append to existing instructions
cat examples/CLAUDE.md >> ~/.claude/CLAUDE.md
```

See [examples/CLAUDE.md](examples/CLAUDE.md) for the full instructions template.

**Key points:**
- Prefer `mcp__code-search__search` over built-in `Grep` and `Glob` for finding code
- Use natural language queries: "authentication middleware that validates JWT tokens"
- Fall back to `Grep` only for exact string/regex matches

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

### Admin UI Features

**Folders Tab:**
- View all indexed folders with status
- Add new folders via path input
- Remove folders (deletes indexed data)
- Reindex folders (useful after upgrading to get new features)

**Queries Tab:**
- Query history with expandable results
- Timeline or per-folder view
- Clear query logs

**Ingestion Tab:**
- Real-time indexing progress
- File counts and error tracking

**Services Tab:**
- Ollama status and controls (start/stop)
- LSP enrichment status

**Settings Tab:**
- Embedding cache statistics
- Cache warming controls
- File watcher configuration

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

The server respects `.gitignore` files in indexed folders. You can also create a `.cs-mcp-ignore` file with additional patterns to exclude.

Always ignored directories:
- `node_modules`, `.git`, `dist`, `build`, `.next`, `.cache`, `coverage`, `.venv`, `vendor`, `target`, etc.

---

## Advanced Features

### Embedding Cache

The server caches computed embeddings in SQLite to avoid redundant API calls. When re-indexing or updating files:
- Unchanged code chunks reuse cached embeddings
- Only new/modified code requires embedding API calls
- Cache is keyed by content hash and model ID

The cache auto-warms from existing Qdrant data on startup.

### LSP Enrichment (Optional)

Enable Language Server Protocol integration to enrich code chunks with type information before embedding:

```json
{
  "lspEnabled": true,
  "lspTimeout": 5000,
  "lspMaxConcurrentRequests": 5,
  "lspUseOmniSharp": false
}
```

**Benefits:**
- Type signatures improve semantic matching
- Documentation/JSDoc included in embeddings
- Better results for type-related queries

**Prerequisites:**
- TypeScript/JavaScript: `npm install -g typescript-language-server typescript`
- C#: `dotnet tool install --global csharp-ls` (or set `lspUseOmniSharp: true` for OmniSharp)

### Hierarchical Context

Code chunks automatically include parent context from the AST:
- Class name for methods
- Module name for functions
- Namespace for nested types
- Parent function for nested functions

This helps queries like "authentication method in UserService" match more accurately.

### Git Worktree Support

The server automatically detects git worktrees and optimizes indexing:

**How it works:**
1. When you add a worktree folder, the server detects it's a worktree
2. The base repository is automatically discovered and indexed (if not already)
3. Both repos are indexed, but the embedding cache deduplicates shared code
4. Admin UI shows worktree relationships with "worktree" and "base repo" badges

**Benefits:**
- No duplicate embedding API calls for shared code (same content = cached embedding)
- Clear visualization of repo relationships in admin UI
- Automatic cleanup detection for deleted worktrees

**Important:** Keep your base repository checked out to the main/master branch for best results. The index reflects whatever is on disk, not a specific git branch.

**Orphaned folder cleanup:**
If you delete a worktree from disk, the server marks it as "orphaned" on next startup. Use the **Cleanup** button in the admin UI to remove orphaned indexes.

### Reindexing After Upgrade

When upgrading to a version with new enrichment features (LSP, hierarchical context), you need to reindex existing folders to take advantage of the improvements:

1. Open Admin UI at `http://localhost:3100/admin`
2. Go to the **Folders** tab
3. Click **Reindex** on each folder

This clears the existing index and re-indexes all files with the new enrichment features.

---

## Future Improvements

See [FUTURE-IMPROVEMENTS.md](FUTURE-IMPROVEMENTS.md) for planned enhancements including:
- LLM re-ranking for improved relevance
- Multi-level code summaries
- Graph-based relationship tracking
- Hybrid BM25 + vector search

---

## License

MIT License - see [LICENSE](LICENSE) file.

## Third-Party Licenses

See [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) for dependency licenses.
