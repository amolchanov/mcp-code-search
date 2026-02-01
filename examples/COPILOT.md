# GitHub Copilot CLI Instructions

## Code Search Integration

A semantic code search server is available for finding code across indexed repositories.

### Tools Available

1. **search** - Find code by semantic meaning
   - Use natural language queries
   - Example: `search({ query: "function that parses CSV files" })`

2. **add_folder** - Add a repository to the search index
   - Example: `add_folder({ path: "/home/user/projects/myapp" })`

3. **list_folders** - View indexed repositories

4. **get_status** - Check indexing status

### Search Strategy

**Prefer semantic search over grep for finding code:**

| Use Case | Tool |
|----------|------|
| Find where functionality is implemented | `search` |
| Understand code flow | `search` |
| Find related code patterns | `search` |
| Exact string/regex match | `grep` (fallback) |
| Find files by name pattern | `glob` |

### Best Practices

- Search before implementing new features to find existing code
- Use descriptive queries: "retry logic with exponential backoff" not "retry"
- Search for patterns: "singleton pattern implementation"
- Search for specific functionality: "WebSocket connection handler"
- Include context: "validation method in UserService"

### Example Queries

Good semantic queries:
- "authentication middleware that validates JWT tokens"
- "database connection pooling implementation"
- "error handling for API requests"
- "React component that renders a data table"
- "function that calculates shipping costs"
- "unit tests for the payment service"

### Integration Tips

When asked to implement something:
1. First search for existing implementations
2. Review found code for patterns and conventions
3. Either reuse existing code or follow established patterns

When debugging:
1. Search for error handling related to the issue
2. Find similar functionality that works correctly
3. Compare implementations to identify differences
