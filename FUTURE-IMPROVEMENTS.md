# Future Improvements

Ideas for improving search quality and indexing performance, inspired by [PageIndex](https://github.com/VectifyAI/PageIndex) and other research.

## High Priority

### 1. LLM Re-ranking
**Effort: Medium | Impact: High**

After vector retrieval, use an LLM to re-rank results based on actual relevance to the query (not just embedding similarity).

- Vector search returns top-K candidates
- LLM evaluates each candidate against the original query
- Results are re-ordered by semantic relevance
- Trade-off: Adds latency (500-2000ms) and per-query API costs

**Implementation Notes:**
- Make re-ranking optional via config
- Use a fast model (e.g., GPT-4o-mini, Claude Haiku)
- Limit to top 20 candidates to control costs

### 2. Multi-Level Summaries
**Effort: High | Impact: Medium-High**

Generate LLM summaries at different granularities during indexing:
- **File-level**: "This file implements user authentication with JWT tokens"
- **Class-level**: "UserService handles user CRUD operations and password hashing"
- **Module-level**: "The auth/ directory contains authentication, authorization, and session management"

**Benefits:**
- Enables high-level queries like "where is authentication handled?"
- Summaries become searchable chunks themselves
- Provides context for understanding search results

**Considerations:**
- Significantly increases indexing time
- Requires LLM API calls during indexing
- Need to invalidate summaries when code changes

### 3. Graph-Based Relationships
**Effort: High | Impact: High**

Track code relationships that pure vector search misses:
- **Call graphs**: Which functions call which
- **Import dependencies**: Module relationships
- **Type hierarchies**: Inheritance and implementation chains
- **Reference tracking**: Where symbols are used

**Use Cases:**
- "Find all callers of this function"
- "What depends on this module?"
- "Show implementations of this interface"

**Implementation:**
- Build graph during parsing phase
- Store in SQLite or graph database
- Combine graph traversal with vector search

## Medium Priority

### 4. Hybrid Search (BM25 + Vector)
**Effort: Medium | Impact: Medium**

Combine traditional keyword search with semantic search:
- BM25 for exact matches (function names, variable names)
- Vector search for semantic meaning
- Fuse results with reciprocal rank fusion

**Benefits:**
- Better for queries with specific identifiers
- Catches cases where embedding misses exact terms
- Fast fallback when vectors don't help

### 5. Query Expansion
**Effort: Low-Medium | Impact: Medium**

Automatically expand queries with related terms:
- "auth" → "authentication", "authorization", "login", "JWT"
- Use embeddings to find semantically similar terms
- Or use LLM to generate query variations

### 6. Contextual Chunking Improvements
**Effort: Medium | Impact: Medium**

Improve how we split code into chunks:
- **Sliding window with overlap**: Ensure context isn't lost at boundaries
- **Semantic boundaries**: Split at logical points (functions, classes) rather than character limits
- **Context preservation**: Include imports and type definitions with each chunk

### 7. Search Result Clustering
**Effort: Medium | Impact: Medium**

Group similar results together:
- Cluster results by file, class, or semantic similarity
- Show one representative from each cluster
- Allow expanding clusters for more results

## Lower Priority

### 8. Feedback Loop / Learning
**Effort: High | Impact: Medium**

Learn from user behavior to improve results:
- Track which results users click/use
- Boost frequently selected results
- Down-rank results users ignore

### 9. Incremental Index Updates
**Effort: Medium | Impact: Low-Medium**

Currently, file changes trigger re-parsing and re-embedding of the entire file. Could optimize to:
- Only re-embed changed functions
- Use diff analysis to minimize work
- Cache unchanged embeddings by content hash (already implemented)

### 10. Multi-Modal Search
**Effort: High | Impact: Low**

Support non-code artifacts:
- Diagrams (architecture, ERD)
- Screenshots (UI mockups)
- Documentation images

---

## Recently Implemented

### Embedding Cache (SQLite)
Caches computed embeddings to avoid redundant API calls. When re-indexing, unchanged code chunks reuse cached embeddings.

### LSP Enrichment
Uses Language Server Protocol to enrich code chunks with:
- Type signatures
- Documentation/JSDoc
- Improves embedding quality for TypeScript, JavaScript, and C#

### Parent Context Enrichment
Extracts hierarchical context from AST:
- Class name for methods
- Module name for functions
- Namespace for nested types
- Included in embeddings for better semantic matching

### Git Worktree Support
Automatically detects git worktrees and links them to their base repository:
- Auto-discovers and indexes base repo when adding a worktree
- Embedding cache deduplicates shared code (same content hash = cached embedding)
- Admin UI shows worktree/base-repo relationships
- Orphaned folder detection and cleanup for deleted worktrees

**Current limitation:** Base repo should stay on main/master branch for best results. The index reflects whatever is on disk, not a specific branch.

---

## Planned: Multi-Branch Support

### Branch-Aware Indexing
**Effort: High | Impact: Medium-High**

Full support for indexing and searching across multiple branches without separate checkouts.

**Current state:**
- Each folder (worktree) is indexed as-is
- Branch switching in a checkout triggers re-indexing of changed files
- No explicit branch tracking or filtering

**Potential approaches:**

#### Option A: Track branch per index
```typescript
// Store branch info with folder
{
  branch: "main",
  lastCommit: "abc123"
}

// On startup, detect if branch changed
// Warn user or auto-reindex
```
- Pro: Simple, catches drift
- Con: Doesn't support searching across branches

#### Option B: Index from git objects (not working directory)
```bash
# Read committed file state from any branch
git show main:src/file.ts
git show feature-x:src/file.ts
```
- Pro: Can index any branch without checkout
- Con: Complex file reading, no uncommitted changes

#### Option C: Virtual branch indexes with merge-base
```bash
# Find common ancestor between branches
git merge-base feature-x main

# Index:
# 1. Common ancestor (shared base)
# 2. Branch-specific changes as overlays
```
- Pro: Efficient storage, shows what's unique to each branch
- Con: Complex merge-base tracking

#### Option D: Tag points with branch + commit
```typescript
// Each vector point includes:
{
  branch: "feature-x",
  commitHash: "abc123",
  filePath: "src/auth.ts"
}

// Search can filter by branch
search({ query: "...", branch: "main" })
```
- Pro: Full flexibility, search any branch
- Con: Storage overhead, stale data management

**Recommended path:**
1. Start with Option A (track branch, warn on change)
2. Add Option D (branch tagging) for multi-branch search
3. Consider Option C for storage optimization if needed

**Use cases to support:**
- "Search only in main branch"
- "Find differences between feature branch and main"
- "Search across all branches"
- "What changed in this branch vs main?"

---

## Research References

- [PageIndex](https://github.com/VectifyAI/PageIndex) - Reasoning-based hierarchical indexing
- [Cursor Codebase Indexing](https://cursor.com/blog/secure-codebase-indexing) - Merkle trees and simhash for efficient indexing
- [RAG Fusion](https://arxiv.org/abs/2402.03367) - Combining multiple retrieval strategies
- [ColBERT](https://arxiv.org/abs/2004.12832) - Late interaction for better retrieval
