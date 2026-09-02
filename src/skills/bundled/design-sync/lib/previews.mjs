// .design-sync/previews/<Name>.tsx — auto-generated, user-ownable JSX preview
// files. One per component; named exports become labeled cells in <Name>.html.
// First line is the ownership marker: with marker → regenerated each run;
// without → user-owned, left untouched. Compiled to ds-bundle/_preview/<Name>.js
// (IIFE → window.__dsPreview) by buildPreviews.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lookupArgsById } from './common.mjs';

// The ownership marker embeds a sha12 of the body-after-line-1 so an edit
// below the marker is detected (not silently overwritten). BOM-stripped and
// prefix-matched — Windows editors can prepend U+FEFF. A marker without a
// hash (pre-this-change format) regenerates once.
const MARKER_TAIL = '— delete this line to keep your edits across re-syncs.';
export const MARKER_RE = /^\uFEFF?\/\/ @ds-preview generated(?:\s+([0-9a-f]{12}))?\b/;
const bodyHash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const markerLine = (body) => `// @ds-preview generated ${bodyHash(body)} ${MARKER_TAIL}`;

// JS keywords + common globals a standalone JSX snippet can reference.
const SAFE_IDS = new Set(
  ('React Fragment args undefined null true false void typeof instanceof new ' +
   'delete in of as this return if else switch case default for while do break ' +
   'continue try catch finally throw const let var function class extends super ' +
   'async await yield Array Object JSON Math Date Boolean String Number Symbol ' +
   'Map Set Promise Error RegExp Infinity NaN console window document navigator ' +
   'globalThis alert confirm prompt fetch setTimeout setInterval clearTimeout ' +
   'clearInterval requestAnimationFrame localStorage sessionStorage location ' +
   'history URL URLSearchParams Intl string number boolean any unknown never ' +
   'object').split(/\s+/),
);

// Identifiers in `src` that would be undefined in the generated .tsx — story-
// file-local fixtures (`rows`, `PEOPLE`) the verbatim JSX closes over. Walks
// with a JS/JSX mode bit so JSX text children, attr names, and boolean attrs
// are never read as value references. Best-effort — a false positive falls
// through to args/cfg.previewArgs/variant-grid (today's path), so
// over-reporting is the safe direction.
export function unknownRefs(src, exported) {
  // Bindings declared within `src`: const/let/var (incl. array/object
  // destructuring, for-of/in heads, uninitialized let), function names,
  // arrow-fn params (incl. destructuring). The capture stops at `=`, `;`,
  // `)`, `of`, or `in` so a for-of head doesn't sweep the iterable into
  // locals.
  const local = new Set();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([^=;)]+?)\s*(?:[=;)]|\bof\b|\bin\b)|\bfunction\s+([A-Za-z_$][\w$]*)/g))
    for (const [n] of (m[1] ?? m[2] ?? '').matchAll(/[A-Za-z_$][\w$]*/g)) local.add(n);
  for (const m of src.matchAll(/(?:\(([^()]*)\)|\b([A-Za-z_$][\w$]*))\s*=>/g))
    for (const [n] of (m[1] ?? m[2] ?? '').matchAll(/[A-Za-z_$][\w$]*/g)) local.add(n);
  const known = (id) => SAFE_IDS.has(id) || exported.has(id) || local.has(id);
  const bad = new Set();
  // 'js' = identifiers are value refs; 'jsx' = inside a tag's attr list or
  // text-children region (identifiers there are keys / literal text).
  const st = [];
  let mode = 'js', q = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n1 = src[i + 1] ?? '';
    if (q) {
      if (c === '\\') i++;
      else if (q === '`' && c === '$' && n1 === '{') { st.push('tpl'); mode = 'js'; q = ''; i++; }
      else if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (mode === 'js' && c === '/' && n1 === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (mode === 'js' && c === '/' && n1 === '*') { i = src.indexOf('*/', i + 2); if (i < 0) i = src.length; else i++; continue; }
    if (c === '{') { st.push(mode); mode = 'js'; continue; }
    if (c === '}') {
      const top = st.pop() ?? 'js';
      if (top === 'tpl') q = '`'; else mode = top;
      continue;
    }
    if (c === '<' && (n1 === '>' || n1 === '/' || /[A-Za-z]/.test(n1))) {
      if (n1 === '/') { mode = st.pop() ?? 'js'; while (i < src.length && src[i] !== '>') i++; continue; }
      const h = src.slice(i + 1).match(/^[A-Za-z_$][\w$]*/)?.[0] ?? '';
      if (/^[A-Z]/.test(h) && !known(h)) bad.add(h);
      st.push(mode); mode = 'jsx'; i += h.length; continue;
    }
    if (mode === 'jsx') {
      if (c === '/' && n1 === '>') { mode = st.pop() ?? 'js'; i++; }
      continue;
    }
    // mode === 'js': check an identifier starting here.
    const m = src.slice(i).match(/^[A-Za-z_$][\w$]*/);
    if (!m) continue;
    const id = m[0], p1 = src[i - 1], p2 = src[i - 2];
    // `as Type` — the cast target is a type name, not a value. -1 so the
    // loop's i++ lands on the char immediately after the type.
    if (id === 'as') {
      const t = src.slice(i + 2).match(/^\s*[A-Za-z_$][\w$.]*/)?.[0];
      i += id.length + (t?.length ?? 0) - 1; continue;
    }
    const isProp = p1 === '.' && p2 !== '.';
    // Only object-literal key positions (`{k:` or `, k:`), not ternary `? b :`.
    const prevNW = src.slice(0, i).match(/(\S)\s*$/)?.[1];
    const isKey = (prevNW === '{' || prevNW === ',') && /^\s*:/.test(src.slice(i + id.length));
    if (!isProp && !isKey && !known(id)) bad.add(id);
    i += id.length - 1;
  }
  return [...bad];
}

// Export name from a story name: PascalCase the alnum runs; prefix S if it
// would start with a digit. Dedup with a counter.
function exportName(storyName, used) {
  let n = String(storyName ?? 'Default').split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join('') || 'Default';
  if (/^[0-9]/.test(n)) n = 'S' + n;
  let out = n, i = 2;
  while (used.has(out)) out = `${n}${i++}`;
  used.add(out);
  return out;
}

// Body for one export. renderSource is a JSX element string (extractRenderSource
// returns the first <Name>/<Name.X> element); the captured CSF3 render-fn may
// also be a full arrow/function expression.
function asFn(body) {
  const t = body.trim();
  if (/^(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(t)) return t;
  return `() => (\n  ${t}\n)`;
}

// smartDefaultProps $raw values — a small closed set of literal expressions.
// Whitelist-gated so config-sourced previewArgs can't inject arbitrary JS.
const RAW_OK = /^(?:\(\)\s*=>\s*(?:null|undefined|\{\})|new Date\(\))$/;

// JSON props → JSX attribute string. Functions / React elements drop out.
// `$raw` values (smartDefaultProps' crash-prevention stubs) emit as bare
// expression containers; everything else as `{JSON.stringify(v)}`.
function propsToJsx(args) {
  const out = [];
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'function' || (v && typeof v === 'object' && v.$$typeof)) continue;
    // Dotted argType keys (`Title.as`) are sub-component addressing — not a
    // valid JSX attr name on the root.
    if (k === 'children' || k.includes('.')) continue;
    if (v && typeof v === 'object' && typeof v.$raw === 'string') {
      if (RAW_OK.test(v.$raw)) out.push(` ${k}={${v.$raw}}`);
    } else if (v && typeof v === 'object' && v.$jsx) {
      // scaffold-only marker — not expressible as a JSX attr here
    } else if (v === true) out.push(` ${k}`);
    else {
      try { out.push(` ${k}={${JSON.stringify(v)}}`); } catch { /* skip uncloneable */ }
    }
  }
  return out.join('');
}

// Children between `>`/`<` — wrap in `{JSON.stringify(...)}` so a value
// containing `{ } < >` doesn't reopen the parser. `{"plain"}` renders the
// same as `plain`, so always-wrap is correct.
const jsxChildren = (s) => `{${JSON.stringify(s)}}`;

// Placeholder child for the precedence-3/4/5 paths where smartDefaultProps
// would have set children to the bare component name. Renders a visible
// dashed box so the screenshot makes placeholder-ness obvious, and carries
// data-ds-placeholder so validate can flag it as needs-attention.
const placeholderChild = (name) =>
  `<div data-ds-placeholder="" style={{padding:8,minHeight:40,maxWidth:'100%',overflow:'hidden',boxSizing:'border-box',border:'1px dashed #999',color:'#999',fontSize:12}}>` +
  `{${JSON.stringify(name + ' content')}}</div>`;
const childJsx = (kids, name) => (kids === name ? placeholderChild(name) : jsxChildren(kids));

// PascalCase identifiers referenced as JSX tags, namespace heads, or bare
// attribute values (`icon={PlusIcon}`) in the renderSource bodies — best-
// effort regex, intersected with the DS export set.
function referencedExports(bodies, exported, own) {
  const refs = new Set([own]);
  const rx = /<([A-Z][A-Za-z0-9_]*)|(?:^|[^.\w])([A-Z][A-Za-z0-9_]*)\.|[{,[(]\s*([A-Z][A-Za-z0-9_]*)\s*[},\])]/g;
  for (const b of bodies) for (const m of b.matchAll(rx)) {
    const n = m[1] || m[2] || m[3];
    if (exported.has(n)) refs.add(n);
  }
  return [...refs].sort();
}

// Generate the preview .tsx body for one component (marker is prepended by
// writePreviewFiles so its hash covers this body only).
export function generatePreviewSource(c, { smart, members, exported, pkg, skip, previewArgs }) {
  // smart.props carries crash-prevention stubs from the .d.ts (required
  // callbacks → {$raw:'()=>null'}, arrays → [], open/visible → true). Spread
  // under explicit args so stubs fill gaps without overriding real values.
  const stubs = smart?.props ?? {};
  const stubKids = typeof stubs.children === 'string' ? stubs.children : null;
  // cfg.overrides.<Name>.skip mirrors emit.mjs's visibleStoryIds.
  const skipSet = new Set(skip ?? []);
  const stories = (c.storyIds ?? []).filter((s) => !skipSet.has(s.id));
  // Precedence 1/2: stories with renderSource or real args. Same fuzzy
  // argsById lookup emit.mjs uses (index.json ids vs composeStories ids may
  // differ in their title prefix). Seed `used` with the DS export set so a
  // story named like a DS export (`export const Form = () => <Form/>`)
  // doesn't shadow the import.
  const used = new Set(exported);
  const exports = [];
  const bodies = [];
  const skipped = [];
  for (const s of stories) {
    const e = lookupArgsById(c.argsById, s.id, c.name);
    let rs = e?.renderSource && /<[A-Z]/.test(e.renderSource) ? e.renderSource : null;
    if (rs) {
      const unknown = unknownRefs(rs, exported);
      if (unknown.length) { skipped.push([s.name, unknown]); rs = null; }
    }
    if (rs) {
      const body = asFn(rs);
      exports.push(`export const ${exportName(s.name, used)} = ${body};`);
      bodies.push(body);
    } else if (e?.args && Object.keys(e.args).length) {
      const kids = (typeof e.args.children === 'string' ? e.args.children : null) ?? stubKids;
      const attrs = propsToJsx({ ...stubs, ...e.args });
      const jsx = kids
        ? `<${c.name}${attrs}>${childJsx(kids, c.name)}</${c.name}>`
        : `<${c.name}${attrs} />`;
      exports.push(`export const ${exportName(s.name, used)} = () => ${jsx};`);
    }
  }
  // Precedence 2.5: cfg.previewArgs — accumulated config fixes from the §4
  // verify loop. Slot between story-derived exports and the variant grid so a
  // user-supplied previewArgs survives into the generated file.
  if (previewArgs) {
    const kids = (typeof previewArgs.children === 'string' ? previewArgs.children : null) ?? stubKids;
    const attrs = propsToJsx({ ...stubs, ...previewArgs });
    const jsx = kids
      ? `<${c.name}${attrs}>${childJsx(kids, c.name)}</${c.name}>`
      : `<${c.name}${attrs} />`;
    exports.push(`export const ${exportName('Preview', used)} = () => ${jsx};`);
  }
  if (skipped.length) {
    const refs = [...new Set(skipped.flatMap(([, u]) => u))].slice(0, 5);
    console.error(`  (preview: ${c.name} — ${skipped.length} renderSource(s) skipped, undeclared refs: ${refs.join(', ')}${refs.length < skipped.flatMap(([, u]) => u).length ? ', …' : ''})`);
  }
  if (exports.length) {
    const imports = referencedExports(bodies, exported, c.name);
    return `import { ${imports.join(', ')} } from '${pkg}';\n\n${exports.join('\n\n')}\n`;
  }
  // parentHint (tier-2 prefix-match) → emit an EXTRA cell wrapping this
  // component in its likely parent. For true subparts (TableRow) the wrapped
  // cell renders while Default is blank; for standalone-ok (FormItem) it's a
  // redundant extra cell. Never replaces the primary export.
  const parent = c.parentHint && exported.has(c.parentHint) ? c.parentHint : null;
  const selfAttrs = propsToJsx(stubs);
  const selfJsx = stubKids ? `<${c.name}${selfAttrs}>${childJsx(stubKids, c.name)}</${c.name}>` : `<${c.name}${selfAttrs} />`;
  const imps = parent ? [c.name, parent].sort().join(', ') : c.name;
  const wrap = (body) => parent
    ? `${body}\nexport const In${parent} = () => (\n  <${parent}>\n    ${selfJsx}\n  </${parent}>\n);\n`
    : body;
  // Precedence 3: variant grid from the .d.ts literal-union.
  if (smart?.variants) {
    const { prop, values } = smart.variants;
    const cells = values.slice(0, 4)
      .map((v) => `    <${c.name}${propsToJsx({ ...stubs, [prop]: v })}${stubKids ? `>${childJsx(stubKids, c.name)}</${c.name}>` : ' />'}`)
      .join('\n');
    return wrap(`import { ${imps} } from '${pkg}';\n\nexport const Variants = () => (\n  <>\n${cells}\n  </>\n);\n`);
  }
  // Precedence 4: namespace stub from the members list. Likely renders blank —
  // the value is that the user has the right file to edit.
  if (members?.length) {
    const root = members.includes('Root') ? `${c.name}.Root` : c.name;
    const item = members.find((m) => /^(Item|Panel|Tab|Trigger|Content|Body)$/.test(m)) ?? members[0];
    return wrap(`import { ${imps} } from '${pkg}';\n\nexport const Default = () => (\n  <${root}>\n    <${c.name}.${item}>${placeholderChild(c.name)}</${c.name}.${item}>\n  </${root}>\n);\n`);
  }
  // Precedence 5: smart-default fallback.
  return wrap(`import { ${imps} } from '${pkg}';\n\nexport const Default = () => ${selfJsx};\n`);
}

// Apply the marker rule per component, log overrides and stale files.
export function writePreviewFiles({ components, previewDir, gen }) {
  mkdirSync(previewDir, { recursive: true });
  const names = new Set(components.map((c) => c.name));
  let generated = 0, overrides = 0, edited = 0;
  for (const c of components) {
    const p = join(previewDir, `${c.name}.tsx`);
    // CRLF-normalize so a Windows checkout hashes the same as the commit.
    let txt = null;
    try { txt = readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } catch { /* absent */ }
    if (txt !== null) {
      const nl = txt.indexOf('\n');
      const line1 = nl < 0 ? txt : txt.slice(0, nl);
      const rest = nl < 0 ? '' : txt.slice(nl + 1);
      const m = line1.match(MARKER_RE);
      if (!m) {
        overrides++;
        console.error(`  (preview override: ${c.name})`);
        continue;
      }
      if (m[1] && m[1] !== bodyHash(rest)) {
        edited++;
        console.error(`  (preview edited under marker: ${c.name} — delete line 1 to keep, or delete the file to regenerate)`);
        continue;
      }
    }
    const body = gen(c);
    writeFileSync(p, `${markerLine(body)}\n${body}`);
    generated++;
  }
  // Stale: file for a component that's no longer exported. Marker-bearing →
  // ours to remove (keeps re-sync idempotent); user-owned → log only.
  for (const f of readdirSync(previewDir)) {
    if (!f.endsWith('.tsx')) continue;
    const n = f.slice(0, -4);
    if (names.has(n)) continue;
    const p = join(previewDir, f);
    const firstLine = readFileSync(p, 'utf8').split('\n', 1)[0];
    if (MARKER_RE.test(firstLine)) {
      rmSync(p);
      console.error(`  (stale preview removed: ${n})`);
    } else {
      console.error(`  (stale preview: ${n} — component no longer exported)`);
    }
  }
  const extras = [overrides && `${overrides} user-owned`, edited && `${edited} edited-under-marker`].filter(Boolean);
  console.error(`  previews: ${generated} generated${extras.length ? `, ${extras.join(', ')}` : ''} → .design-sync/previews/`);
}

// Compile each .design-sync/previews/<Name>.tsx → ds-bundle/_preview/<Name>.js
// (IIFE assigning named exports to window.__dsPreview). react/react-dom and the
// DS package are externalized to the window globals already on the page.
// Per-file build so one bad file doesn't sink the rest.
export async function buildPreviews({ components, previewDir, OUT, GLOBAL, PKG, reactShim, NODE_MODULES, pathsPlugin, extraEntries }) {
  const built = new Set();
  const outDir = join(OUT, '_preview');
  mkdirSync(outDir, { recursive: true });
  // The DS package (and any extraEntries — their exports already live on
  // window.<GLOBAL> via the merged bundle entry) resolve to that global. Same
  // shim approach as bundle.mjs's reactShim.
  const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pkgRx = new RegExp(`^(?:${[PKG, ...(extraEntries ?? [])].map(escRx).join('|')})(?:/.*)?$`);
  const dsShim = {
    name: 'ds-global',
    setup(b) {
      b.onResolve({ filter: pkgRx }, () => ({ path: 'ds', namespace: 'ds-shim' }));
      b.onLoad({ filter: /.*/, namespace: 'ds-shim' }, () => ({
        contents: `module.exports=window.${GLOBAL};`, loader: 'js',
      }));
    },
  };
  // Same nodePaths + tsconfig-paths plugin bundleToIife uses, so a user-owned
  // preview that imports `@/lib/utils` or a workspace dep resolves the same way.
  const plugins = pathsPlugin ? [pathsPlugin, reactShim, dsShim] : [reactShim, dsShim];
  for (const c of components) {
    const entry = join(previewDir, `${c.name}.tsx`);
    if (!existsSync(entry)) continue;
    try {
      await build({
        entryPoints: [entry], outfile: join(outDir, `${c.name}.js`),
        bundle: true, format: 'iife', globalName: '__dsPreview',
        jsx: 'automatic', platform: 'browser', charset: 'utf8',
        nodePaths: NODE_MODULES ? [NODE_MODULES] : undefined,
        plugins,
        loader: { '.css': 'empty' },
        define: { 'process.env.NODE_ENV': '"development"' },
        logLevel: 'silent',
      });
      built.add(c.name);
    } catch (e) {
      // Surface esbuild's location info so the agent can fix the .tsx, not
      // just "build failed".
      const err = e?.errors?.[0];
      const loc = err?.location;
      const where = loc ? ` (${loc.file}:${loc.line}:${loc.column})` : '';
      const msg = err?.text ?? e?.message ?? String(e);
      console.error(`  ! preview build failed: ${c.name}: ${String(msg).split('\n')[0]}${where}`);
      if (loc?.lineText) console.error(`    ${loc.lineText}\n    ${' '.repeat(loc.column)}^`);
    }
  }
  return built;
}
