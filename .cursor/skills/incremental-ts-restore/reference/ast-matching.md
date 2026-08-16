# AST matching

Do not run a whole-file text diff or a whole-tree GumTree on 18–50 MB `cli.js`. Match **functions**, then edit.

## Signals that survive minify

1. String / template / regex literals (primary).
2. Numeric constants and unmangled object keys.
3. Call-graph shape (callee count, arity).
4. α-normalized skeleton: replace identifiers with `ID`, strings with `STR`, hash the node-type sequence (`fingerprint.mjs` → `skeletonHash` + `stringHash`).

## Classification

| Class | Test | LLM? |
|---|---|---|
| `unchanged` | Same `stringHash` + `skeletonHash` (or only identifier leaves differ) | No |
| `rename-only` | Same skeleton and string set; exported/minified name changed | No |
| `small-edit` | High string overlap; small skeleton delta | Yes, patch the baseline TS file |
| `rewrite` | Same string anchors, large skeleton change | Yes, rewrite that file |
| `added` | No previous function claims the string set | Yes, new file |
| `removed` | Previous function has no target match | Delete/stub only with evidence |

A function must receive exactly one class. The hop's `functions` array must cover every target fingerprint plus every unmatched previous function (`removed`).

## 2.1.88 prior

Build `dist/cli.js` from this tree, fingerprint it, and treat `src/**` names as the prior. Later hops use the previous hop's ledger as the prior, not a fresh humanify.

## Tools

- Default: `scripts/fingerprint.mjs` (Acorn).
- Optional later: GumTree edit scripts **on a matched pair only**.
- Do not use difftastic/diffsitter as a gate (identifier leaves explode).
- `ast-grep` is for known patterns (e.g. Cometix P2), not matching.
