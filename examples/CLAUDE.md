# Claude Code Instructions

## Code Search Strategy

**IMPORTANT:** Always prefer the `mcp__code-search__search` tool over built-in `Grep` and `Glob` tools for finding code.

### When to use `mcp__code-search__search` (DEFAULT)
- Finding where functionality is implemented ("where do we handle authentication")
- Understanding code flow ("how does the session manager work")
- Locating related code ("find all error handling logic")
- Exploring unfamiliar parts of the codebase
- Any natural language query about the code

### When to use `Grep` (FALLBACK ONLY)
- `mcp__code-search__search` returns no results or service is unavailable
- Searching for exact strings, symbols, or regex patterns (e.g., `className`, `TODO:`)
- Finding specific identifiers or variable names

### When to use `Glob`
- Finding files by name pattern (e.g., `**/*.cs`, `**/test_*.py`)
- Listing files in a directory structure

### Search workflow
1. **First:** Try `mcp__code-search__search` with a descriptive natural language query
2. **If no results:** Fall back to `Grep` with specific patterns
3. **For file discovery:** Use `Glob` for pattern-based file finding

## Available MCP Tools

- `mcp__code-search__search` - Semantic code search
  - query: Natural language description of what you're looking for
  - folderPath: (optional) Limit search to a specific folder
  - maxResults: (optional) Number of results (default: 10)

- `mcp__code-search__add_folder` - Index a new folder for searching
- `mcp__code-search__list_folders` - See all indexed folders and their status
- `mcp__code-search__get_status` - Check indexing progress

## Example Queries

Good semantic queries:
- "authentication middleware that validates JWT tokens"
- "database connection pooling implementation"
- "error handling for API requests"
- "React component that renders a data table"
- "method that handles user login in AuthController"
- "function that validates email addresses"

## Tips

- Be descriptive: "user authentication" works better than "auth"
- Include context: "validation method in UserService" helps narrow results
- Search before implementing: find existing patterns to follow
