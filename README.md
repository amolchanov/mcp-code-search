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

## Running the Server

The server can run in two modes:

### Mode 1: Stdio (for CLI integration)

Used when integrating with Claude CLI, Copilot, or other MCP clients:

```bash
# Run directly (waits for JSON-RPC input on stdin)
node dist/index.js

# Or with auto-indexing of specific folders
node dist/index.js --index /path/to/project1 --index /path/to/project2
```

In stdio mode, the server communicates via stdin/stdout using the MCP protocol. This is what Claude CLI uses when you add it as an MCP server.

### Mode 2: SSE with Admin UI (for web dashboard)

Used for the web-based admin interface:

```bash
# Start with default port 3100
node dist/index.js --sse

# Or specify a custom port
node dist/index.js --sse --port 8080

# With system tray icon (Windows/macOS)
node dist/index.js --sse --tray

# With auto-indexing
node dist/index.js --sse --index /path/to/project
```

Then open: **http://localhost:3100/admin**

### Command Line Options

| Option | Description |
|--------|-------------|
| `--sse` | Run in SSE mode with HTTP server and Admin UI |
| `--port <number>` | HTTP port for SSE mode (default: 3100) |
| `--tray` | Show system tray icon (SSE mode only) |
| `--index <path>` | Auto-index a folder on startup (can be repeated) |

### Running Both Modes

You can run both modes simultaneously for different use cases:

```bash
# Terminal 1: Admin UI for monitoring
node dist/index.js --sse --port 3100

# Terminal 2: Claude CLI uses stdio mode automatically
# (configured via 'claude mcp add' command)
```

**Note:** When Claude CLI spawns the server, it runs in stdio mode. The SSE server is independent and can run alongside for admin/monitoring purposes.

---

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

**Recommended: Use the Claude CLI command:**

```bash
# Add to current project (creates .mcp.json in project root)
claude mcp add code-search -s project -- node /path/to/code-search-mcp/dist/index.js

# Or add globally for all projects (user-level config)
claude mcp add code-search -s user -- node /path/to/code-search-mcp/dist/index.js
```

**Windows example:**
```bash
claude mcp add code-search -s project -- node C:/repos/code-search-mcp/dist/index.js
```

**Verify the server is connected:**
```bash
claude mcp list
# Should show: code-search: node ... - ✓ Connected
```

**Alternative: Manual JSON configuration**

Add to `.mcp.json` in your project root:

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

### Step 2: Add Instructions for Claude Code

**Option A: Use the MCP tool (recommended)**

Once connected, ask Claude to run:
```
Use the get_instructions tool to get the code-search instructions, then add them to my CLAUDE.md file.
```

Or via CLI:
```bash
# The get_instructions tool returns markdown content for CLAUDE.md
# Format options: "claude" (default), "copilot", "generic"
```

**Option B: Copy manually**

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

You can configure the server globally (for all repos) or per-repository:

#### Option A: Global Configuration (All Repositories)

Add this to your global Copilot CLI MCP settings file:

**Location:** `~/.copilot/mcp-config.json` (create if it doesn't exist)

**Windows:** `C:\Users\<username>\.copilot\mcp-config.json`

```json
{
  "mcpServers": {
    "code-search": {
      "type": "local",
      "command": "node",
      "args": ["/path/to/code-search-mcp/dist/index.js"],
      "tools": ["*"]
    }
  }
}
```

**Windows example:**
```json
{
  "mcpServers": {
    "code-search": {
      "type": "local",
      "command": "node",
      "args": ["c:/repos/mcp-code-search/dist/index.js"],
      "tools": ["*"]
    }
  }
}
```

#### Option B: Repository-Specific Configuration

Add `.copilot/mcp-config.json` to your repository root:

```bash
# In your project repository
mkdir -p .copilot
touch .copilot/mcp-config.json
```

Add the same configuration:

```json
{
  "mcpServers": {
    "code-search": {
      "type": "local",
      "command": "node",
      "args": ["/path/to/code-search-mcp/dist/index.js"],
      "tools": ["*"]
    }
  }
}
```

**Note:** 
- Repository-specific config takes precedence over global config
- Don't commit `.copilot/mcp-config.json` to version control (add to `.gitignore`)
- If you already have MCP servers configured, add the `code-search` entry to the existing `mcpServers` object

### Step 2: Add Instructions for Copilot

Copy the example instructions to your Copilot instructions file:

See [examples/COPILOT.md](examples/COPILOT.md) for the full instructions template.

**Key points:**
- Prefer semantic search over grep for finding code
- Use descriptive natural language queries
- Search before implementing to find existing patterns

---

## Admin UI Features

The Admin UI is available when running in SSE mode (see [Running the Server](#running-the-server)):

```bash
node dist/index.js --sse
# Then open: http://localhost:3100/admin
```

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

### Per-Folder Embedding Models

You can configure different embedding models for different folders via the Admin UI. This is useful when:
- Some projects need higher quality embeddings (use larger models)
- Some projects need faster indexing (use smaller models)
- Testing different models for comparison

**Supported models and their context sizes:**

| Model | Provider | Context (tokens) |
|-------|----------|------------------|
| `nomic-embed-text` | Ollama | 8192 |
| `mxbai-embed-large` | Ollama | 512 |
| `text-embedding-3-small` | OpenAI | 8191 |
| `text-embedding-3-large` | OpenAI | 8191 |
| `text-embedding-ada-002` | OpenAI | 8191 |
| `mistral-embed` | Mistral | 8192 |
| `voyage-code-2` | Voyage | 16000 |
| `voyage-code-3` | Voyage | 32000 |
| `gemma2` | Ollama | 8192 |
| `snowflake-arctic-embed` | Ollama | 8192 |

**Note:** For code indexing, models with larger context (8192+ tokens) are recommended to avoid truncation of large functions/classes.

---

## Available Tools Reference

### Management

| Tool | Description |
|------|-------------|
| `add_folder` | Add a folder to be indexed |
| `remove_folder` | Remove a folder from indexing |
| `list_folders` | List all indexed folders |
| `clear_index` | Clear/rebuild index |
| `reindex_folder` | Reindex a folder (clears and rebuilds) |
| `pause_indexing` | Pause indexing for a folder |
| `resume_indexing` | Resume paused indexing |
| `reenrich_folder` | Re-enrich folder with LSP (for folders indexed without LSP) |

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
| `get_instructions` | Get AI assistant instructions (for CLAUDE.md, etc.) |

### CLI Usage Examples

```bash
# From Claude CLI, you can use these tools directly:
# "search for authentication middleware"
# "add folder /path/to/project"
# "pause indexing for project-name"
# "reindex the api folder"
```

---

## Supported Languages

JavaScript, TypeScript, TSX, JSX, Python, Rust, Go, C, C++, C#, Java, Ruby, PHP, Swift, Kotlin, Scala, Elixir, Erlang, Haskell, OCaml, Lua, Perl, R, Julia, Dart, Vue, Svelte, HTML, CSS, SCSS, SQL, GraphQL, Markdown, JSON, YAML, TOML, XML, Bash, PowerShell, Dockerfile, Terraform, Solidity, Zig, Nim, and more.

---

## Ignoring Files

The server respects `.gitignore` files in indexed folders. You can also create a `.cs-mcp-ignore` file with additional patterns to exclude.

Always ignored directories:
- `node_modules`, `.git`, `dist`, `build`, `.next`, `.cache`, `coverage`, `.venv`, `vendor`, `target`, etc.

---

## Data Storage

All server data is stored in a platform-appropriate application data folder:

| Platform | Location |
|----------|----------|
| Windows | `%LOCALAPPDATA%\code-search` |
| macOS | `~/Library/Application Support/code-search` |
| Linux | `~/.local/share/code-search` (or `$XDG_DATA_HOME/code-search`) |

**Folder contents:**

```
code-search/
├── config.json           # Server configuration
├── folders.json          # Indexed folder registry
├── embedding-cache.db    # SQLite embedding cache
├── lsp-cache.db          # LSP enrichment cache
├── queries/              # Query logs (daily JSONL files)
│   └── queries-YYYY-MM-DD.jsonl
└── cache/                # Per-folder file hash cache
    └── {folder-id}.json
```

**Notes:**
- Query logs are automatically cleaned up after 1 day
- Both stdio (Claude CLI) and SSE (Admin UI) servers share the same data
- Embedding cache persists across restarts to avoid redundant API calls

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

## Troubleshooting

### Claude CLI: "Failed to connect" Error

**Symptom:** `claude mcp list` shows `code-search: ... - ✗ Failed to connect`

**Solutions:**

1. **Verify the server can start manually:**
   ```bash
   node /path/to/code-search-mcp/dist/index.js
   ```
   Should output: `[CodeSearch] Server running on stdio`

2. **Check if Qdrant is running:**
   ```bash
   curl http://localhost:6333/collections
   ```
   If not running, start it: `docker run -p 6333:6333 qdrant/qdrant`

3. **Check if Ollama is running (if using Ollama embeddings):**
   ```bash
   curl http://localhost:11434/api/tags
   ```
   If not running, start Ollama and ensure the model is pulled: `ollama pull nomic-embed-text`

4. **Wrong config file location:**
   - Claude CLI reads `.mcp.json` from the project root, NOT `.claude/mcp.json`
   - Use `claude mcp add` command to ensure correct placement
   - Run `claude mcp list` to verify registration

5. **SSE vs stdio mode conflict:**
   - If running the Admin UI in SSE mode (`--sse` flag), Claude CLI cannot connect
   - Stop the SSE server before using stdio mode with Claude CLI
   - Or run two separate instances (different ports)

6. **Rebuild after code changes:**
   ```bash
   npm run build
   ```

### Indexing Stuck or Not Progressing

1. **Check for errors in server output:**
   - Run manually to see logs: `node dist/index.js`
   - Look for embedding API errors (context length, rate limits)

2. **Embedding model context limits:**
   - `mxbai-embed-large`: 512 tokens (small, may truncate code)
   - `nomic-embed-text`: 8192 tokens (recommended for code)
   - Large code chunks are automatically truncated with a warning

3. **Pause and resume indexing:**
   - Use Admin UI or MCP tools to pause/resume
   - Check `get_errors` for specific file failures

### LSP Enrichment Not Working

1. **Check LSP server is installed:**
   ```bash
   # TypeScript/JavaScript
   typescript-language-server --version

   # C#
   csharp-ls --version
   ```

2. **Enable LSP in config:**
   ```json
   { "lspEnabled": true }
   ```

3. **Check LSP status in Admin UI:** Services tab shows LSP server status

### Search Returns Poor Results

1. **Reindex with LSP enabled** for better type information
2. **Use descriptive queries:** "function that validates user email" instead of "validate"
3. **Check folder is fully indexed:** Use `get_status` or Admin UI
4. **Try different embedding model:** Some models work better for code

### Windows Path Issues

1. **Use forward slashes in JSON config:**
   ```json
   "args": ["C:/repos/code-search/dist/index.js"]
   ```
   Not backslashes: `"C:\\repos\\..."` (can cause escaping issues)

2. **Avoid spaces in paths** or ensure proper quoting

### Port Already in Use (SSE Mode)

```bash
# Find what's using port 3100
netstat -ano | findstr :3100  # Windows
lsof -i :3100                 # macOS/Linux

# Use a different port
node dist/index.js --sse --port 3101
```

### Qdrant Connection Refused

1. **Check Docker is running:**
   ```bash
   docker ps | grep qdrant
   ```

2. **Restart Qdrant container:**
   ```bash
   docker restart $(docker ps -q --filter ancestor=qdrant/qdrant)
   # Or start fresh:
   docker run -d -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant
   ```

3. **Check firewall/antivirus** isn't blocking port 6333

### Memory Issues with Large Repositories

1. **Increase Node.js memory limit:**
   ```bash
   node --max-old-space-size=4096 dist/index.js
   ```

2. **Index folders incrementally** instead of all at once

3. **Use `.cs-mcp-ignore`** to exclude large generated files or vendor directories

### Embedding API Rate Limits

1. **Use Ollama for local embeddings** (no rate limits)
2. **Pause and resume indexing** to spread out API calls
3. **Check provider dashboard** for rate limit details
4. The embedding cache prevents redundant calls on re-indexing

---

## License

MIT License - see [LICENSE](LICENSE) file.

## Third-Party Licenses

See [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) for dependency licenses.
