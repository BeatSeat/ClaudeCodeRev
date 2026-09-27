# AST Structural Diffing with astdiff

We use **[shcv/astdiff](https://github.com/shcv/astdiff)** — a high-performance AST-based structural diff tool designed specifically for minified and obfuscated JavaScript.

Instead of text line diffing or naive token hashing, `astdiff` extracts and matches function declarations based on semantic AST structure.

## Why astdiff on Minified JS?

1. **AST Extraction**: Uses Tree-sitter to parse JavaScript and extract all functions, variables, classes, imports, and exports.
2. **Structural Hashing & MinHash**: Creates compact 64-bit structural hash signatures and MinHash similarity estimators, reducing comparison complexity from \(O(n^2)\) to fast parallel lookups.
3. **Semantic Fingerprinting**: Extracts literals, string constants, and call patterns to accurately pair functions across versions even when minified variable and function names are completely randomized.
4. **Change Classification**: Intelligently separates changes into:
   - **Additions / Deletions**: Genuinely new or removed declarations
   - **Modifications**: Matched declarations with structural code edits
   - **Renames**: Matched declarations whose body structure is preserved but whose mangled identifier changed

## CLI Usage

### Installation

```bash
cargo install --git https://github.com/shcv/astdiff
```

### Basic Comparison

```bash
# Structural AST unified diff of matched and modified declarations
astdiff old.js new.js

# Summary view without declaration bodies (shows similarity percentage and change counts)
astdiff old.js new.js --summary

# Compact location summary
astdiff old.js new.js --compact

# JSON output for automated scripting
astdiff old.js new.js --format json
```

### Renames & Mappings

```bash
# Show renamed functions in output (hidden by default to reduce noise)
ASTDIFF_SHOW_RENAMES=1 astdiff old.js new.js

# Export detected declaration renames (old mangled name -> new mangled name)
astdiff old.js new.js --export-mappings renames.yaml
```

### Dumps & Query Inspection

For large bundles (e.g. Claude Code ~49MB `cli.js`), dumps can be generated once and queried interactively:

```bash
# Create dump
astdiff old.js new.js --dump comparison.astdump

# Query specific declarations
astdiff query comparison.astdump find <functionName>
astdiff query comparison.astdump match <functionName>
astdiff query comparison.astdump unmatched-from1
astdiff query comparison.astdump validate old.js new.js

# Load and inspect dump
astdiff load comparison.astdump
```

### Inspection & Canonicalization

```bash
# Inspect a specific declaration across bundles
astdiff inspect file.js functionName
astdiff inspect file.js functionName --compare-file other.js

# Canonicalize variable names
astdiff canon input.js
astdiff canon input.js --map
```

## How to Apply to Incremental TypeScript Restore

1. Run `astdiff from/cli.js to/cli.js --summary` to get the scope of changes.
2. Inspect structural diffs (`astdiff from/cli.js to/cli.js`) to see the actual functional modifications and new declarations.
3. Use `astdiff query` or `astdiff inspect` to drill into functions that correlate with CHANGELOG items.
4. Apply the corresponding edits to `src/**/*.ts`. Keep functions that are structurally unchanged or rename-only untouched.
