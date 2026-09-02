// Node-side story-args extraction shared by both source adapters. Each
// story file is esbuild-transpiled (packages:external), dynamically
// imported, and run through composeStories — best-effort, per-file
// try/catch so one broken story (CSS import, ?raw loader, path alias)
// doesn't kill the rest.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Project, SyntaxKind, ts } from 'ts-morph';
import { ls } from './common.mjs';

// Resolve and import @storybook/react from the DS repo's own dependency tree.
// pnpm/yarn-berry monorepos don't hoist, so a bare specifier or a direct
// `node_modules/@storybook/react` join both fail — use createRequire.resolve
// from (a) near the .storybook/ dir (where it's actually a dep) and (b) the
// --node-modules root. Returns the imported module or null.
export async function importStorybookReact({ nodeModules, sbDir }) {
  const bases = [sbDir, nodeModules].filter(Boolean).map((d) => resolve(d, '_'));
  for (const base of bases) {
    try {
      const entry = createRequire(pathToFileURL(base)).resolve('@storybook/react');
      return await import(pathToFileURL(entry).href);
    } catch {}
  }
  // Last resort: bare specifier (works when scripts are under the repo tree).
  try { return await import('@storybook/react'); } catch {}
  return null;
}

// ── Built-chunk extraction (storybook-static/assets/*.stories-*.js) ────────
// Storybook's build has already resolved everything the Node-side transpile
// below fights against: deps bundled, docgen applied, args/argTypes composed
// onto the exported story objects. We rewrite the chunk's relative imports to
// a self-returning stub and import it — args/argTypes/parameters are plain
// data literals that survive; only `.component`/`.render` see the stub.
const STUB_DEF =
  // Vite emits lazy-init thunks `helper((()=>{...C=...}))` — call 0-arity fn
  // args so the exported identifiers are assigned. `then→undefined` so a
  // top-level `await stub` doesn't deadlock.
  'var __s=new Proxy(function(a){' +
  'if(typeof a==="function"&&a.length===0)try{a()}catch(e){}return __s},{' +
  'get:function(t,k){return k==="then"?void 0:__s},' +
  'set:function(){return true}});' +
  // Storybook-injected runtime globals some chunks reference bare.
  'for(var __g of["ACTIONS","PREVIEW_API","GLOBAL","CHANNELS","CLIENT_LOGGER","CORE_EVENTS","TYPES","ADDONS","TEST"])' +
  'globalThis["__STORYBOOK_MODULE_"+__g+"__"]??=__s;';
function stubBuiltChunkImports(src) {
  return STUB_DEF + src
    // Side-effect: `import"./x.css";` → drop. No leading anchor so
    // consecutive side-effect imports don't alternate-match.
    .replace(/\bimport\s*["']\.[^"']*["'];?/g, '')
    .replace(/import\s+(\w+)\s*,\s*(\{[^}]*\})\s*from\s*["']\.[^"']*["'];?/g,
      (_, d, n) => `const ${d}=__s;const${n.replace(/\s+as\s+/g, ':')}=__s;`)
    .replace(/import\s*(?:(\{[^}]*\})|\*\s*as\s+(\w+)|(\w+))\s*from\s*["']\.[^"']*["'];?/g,
      (_, n, s, d) => n ? `const${n.replace(/\s+as\s+/g, ':')}=__s;` : `const ${s ?? d}=__s;`);
}
export async function extractFromBuiltChunks(sbStatic, components, tmpDir) {
  const assets = join(sbStatic, 'assets');
  if (!existsSync(assets)) return new Map();
  const chunks = ls(assets).filter((f) => /\.stories-[\w-]+\.js$/.test(f));
  // importPath base ("./Button.stories.tsx" → "Button") → chunk files.
  // One component can have several *.stories-*.js chunks (Playground + each
  // example split separately) — collect all per base.
  const byBase = new Map();
  for (const f of chunks) {
    const b = f.replace(/\.stories-[\w-]+\.js$/, '');
    (byBase.get(b) ?? byBase.set(b, []).get(b)).push(f);
  }
  const argsById = new Map();
  installBrowserStubs();
  let hits = 0;
  for (const ip of new Set(components.flatMap((c) => [...(c.importPaths ?? [])]))) {
    const base = ip.split('/').pop().replace(/\.stories\.\w+$/, '');
    for (const chunk of byBase.get(base) ?? []) {
    const src = readFileSync(join(assets, chunk), 'utf8');
    const out = join(tmpDir, createHash('sha256').update(chunk).digest('hex').slice(0, 12) + '.mjs');
    writeFileSync(out, stubBuiltChunkImports(src));
    try {
      const mod = await import(pathToFileURL(out).href);
      const meta = mod.default ?? {};
      const order = Array.isArray(mod.__namedExportsOrder) ? mod.__namedExportsOrder : null;
      for (const [name, S] of Object.entries(mod)) {
        if (name === 'default' || name === '__namedExportsOrder' || S == null) continue;
        if (order && !order.includes(name)) continue;
        // composeStories' core behavior: meta.args merged under story.args.
        const args = { ...(meta.args ?? {}), ...(S.args ?? {}) };
        const argTypes = { ...(meta.argTypes ?? {}), ...(S.argTypes ?? {}) };
        if (!Object.keys(args).length && !Object.keys(argTypes).length && typeof S !== 'function') continue;
        const renderSource = (S.parameters ?? meta.parameters)?.docs?.source?.originalSource;
        // Title part uses only the LAST title segment so emit's fuzzy lookup
        // (which matches against the component name, not the full path) can
        // find it: "Components/Button" → "button", not "components-button".
        const titlePart = String(meta.title ?? base).split('/').pop();
        argsById.set(S.id ?? `${titlePart.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}--${name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`, {
          args: Object.keys(args).length ? args : argsFromArgTypes(argTypes),
          argTypes, storyName: S.storyName ?? name,
          renderSource: typeof renderSource === 'string' ? renderSource : null,
        });
      }
      hits++;
    } catch (e) {
      console.error(`  ! chunk import failed: ${chunk}: ${String(e).split('\n')[0]}`);
    }
    }
  }
  if (hits) console.error(`  built-chunk extraction: ${hits}/${chunks.length} chunks → ${argsById.size} stories`);
  return argsById;
}

// Synthesize preview args from a Storybook argTypes map. Reads, in order:
// defaultValue, table.defaultValue.summary, first of control.options /
// options / mapping / type.value[]. Covers the shapes SB7 docgen and manual
// CSF both emit. Function/object-typed controls are skipped.
export function argsFromArgTypes(at) {
  const out = {};
  for (const [k, v] of Object.entries(at ?? {})) {
    if (!v || typeof v !== 'object') continue;
    const t = v.type?.name ?? v.type;
    if (t === 'function' || v.action) continue;
    let val = v.defaultValue;
    if (val === undefined) {
      const s = v.table?.defaultValue?.summary;
      if (s && s !== 'undefined') {
        try { val = JSON.parse(s); } catch { if (!/[(){}[\]]/.test(s)) val = s; }
      }
    }
    if (val === undefined) {
      const opts = v.control?.options ?? v.options
        ?? (v.mapping && Object.keys(v.mapping))
        ?? (Array.isArray(v.type?.value) && v.type.value.map((x) => x?.value ?? x));
      if (Array.isArray(opts) && opts.length) val = opts[0];
    }
    if (val === undefined && t === 'boolean') val = false;
    if (val !== undefined) out[k] = val;
  }
  return out;
}

// CSF3 stories that use `render: () => <JSX>` instead of `.args` have empty
// args at composeStories time. Parse the story file and pull the first
// `<ComponentName …>` JSX element from the export's `render` initializer.
const storyProject = new Project({
  useInMemoryFileSystem: true,
  compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true },
});

export function extractRenderSource(raw, exportName, componentName) {
  const sf = storyProject.createSourceFile('s.tsx', raw, { overwrite: true });
  const decl = sf.getVariableDeclaration(exportName);
  const init = decl?.getInitializer();
  // An object-literal story with no `render` uses the default render — there's
  // no JSX source to extract (don't search decorators/parameters/play).
  const obj = init?.asKind?.(SyntaxKind.ObjectLiteralExpression);
  const render = obj ? obj.getProperty('render') : init;
  if (!render) return null;
  for (const jsx of render.getDescendantsOfKind(SyntaxKind.JsxElement)
    .concat(render.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement))) {
    const tag = (jsx.getOpeningElement?.() ?? jsx).getTagNameNode().getText();
    if (tag === componentName || tag.startsWith(`${componentName}.`)) {
      const txt = jsx.getText();
      return txt.length > 1500 ? null : txt;
    }
  }
  return null;
}

// Stories often touch browser globals at import time — stub enough DOM so
// node-side composeStories doesn't crash on window.matchMedia / document.body.
export function installBrowserStubs() {
  globalThis.window ??= globalThis;
  const noop = () => {};
  const stubEl = () => ({
    style: {}, dataset: {}, childNodes: [], children: [],
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop, hasAttribute: () => false,
    appendChild: (c) => c, removeChild: (c) => c, insertBefore: (c) => c, append: noop, remove: noop,
    addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
    focus: noop, blur: noop, cloneNode: stubEl, attachShadow: stubEl,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    innerHTML: '', textContent: '',
  });
  globalThis.document ??= Object.assign(stubEl(), {
    createElement: stubEl, createElementNS: stubEl, createTextNode: () => ({ textContent: '' }),
    createDocumentFragment: stubEl, createComment: () => ({}),
    body: stubEl(), head: stubEl(), documentElement: stubEl(),
    getElementById: () => null, getElementsByTagName: () => [],
    readyState: 'complete', visibilityState: 'visible', hidden: false, currentScript: null,
  });
  globalThis.matchMedia ??= () => ({ matches: false, addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop });
  globalThis.navigator ??= { userAgent: 'node' };
  globalThis.addEventListener ??= noop;
  globalThis.removeEventListener ??= noop;
  globalThis.dispatchEvent ??= () => true;
  globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => '' });
  globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame ??= clearTimeout;
  globalThis.requestIdleCallback ??= (cb) => setTimeout(cb, 0);
  globalThis.localStorage ??= { getItem: () => null, setItem: noop, removeItem: noop };
  globalThis.HTMLElement ??= class {};
  globalThis.Element ??= globalThis.HTMLElement;
  globalThis.Node ??= class {};
  globalThis.Event ??= class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
  globalThis.CustomEvent ??= globalThis.Event;
  globalThis.customElements ??= { define: noop, get: () => undefined, upgrade: noop, whenDefined: () => Promise.resolve() };
  globalThis.MutationObserver ??= class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  globalThis.IntersectionObserver ??= globalThis.ResizeObserver;
  globalThis.CSS ??= { supports: () => false };
  // Build-time constants that packages:external deps (not transpiled) may
  // reference bare.
  globalThis.__DEV__ ??= false;
}

// Like `packages: 'external'` but any bare specifier that node can't resolve
// from the output .mjs location is stubbed to an empty module instead of left
// as a throwing import — covers side-effect-only polyfills and unhoisted
// pnpm transitive deps the story eval pulls in. Logged once per pkg.
// `shared` carries resolve-cache + stubbed-log-once across a batch of builds
// (one nodeTranspile per story file).
const stubUnresolvable = (outFile, shared) => ({
  name: 'stub-unresolvable',
  setup(b) {
    const req = shared.req ??= createRequire(pathToFileURL(outFile));
    const cache = shared.resolveCache ??= new Map();
    b.onResolve({ filter: /^[^./]/ }, (a) => {
      // Windows absolute entry paths (`C:\…`) match this filter and their
      // drive letter parses like a URI scheme below — let esbuild resolve
      // entry points itself.
      if (a.kind === 'entry-point') return;
      // URI-scheme paths (node:, data:, blob:, http:) → external. Most are
      // CSS url() refs (kind==='url-token') where the stub namespace's JS
      // loader is rejected; JS-side data: imports are rare and externalizing
      // leaves them for node (which may or may not load them — best-effort).
      // `@scope/pkg` isn't a scheme (`@` excluded by ^[a-z]).
      if (/^[a-z][a-z0-9+.-]*:/i.test(a.path)) return { path: a.path, external: true };
      // Package-name import: external if node can resolve it from the output
      // file's location, else stub (logged — these are the informative ones).
      let ok = cache.get(a.path);
      if (ok === undefined) {
        try { req.resolve(a.path); ok = true; } catch { ok = false; }
        cache.set(a.path, ok);
        if (!ok) console.error(`  ! stubbed unresolvable: ${a.path}`);
      }
      return ok ? { path: a.path, external: true } : { path: a.path, namespace: 'stub-unresolvable' };
    });
    // Plain null-prototype CJS object — no Proxy. Side-effect imports work;
    // default/named imports destructure to undefined; any call/iterate on
    // them throws a normal TypeError that the per-file catch logs. The
    // Proxy-based stub hit 4 successive edge cases (ownKeys, descriptor,
    // Symbol.iterator, …) — not worth it for args-extraction.
    b.onLoad({ filter: /.*/, namespace: 'stub-unresolvable' }, () => ({
      contents: 'module.exports=Object.create(null);', loader: 'js',
    }));
  },
});

// Retry mode for stories whose externalized deps Node can't import natively
// (.json without an import attribute, raw .css, .ts/.tsx workspace source):
// keep react/react-dom/@storybook external (their identity must match the
// importing process), let esbuild's own node-style resolver handle every
// other bare specifier, and stub only what esbuild itself can't find.
const bundleDepsResolve = {
  name: 'bundle-deps',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, async (a) => {
      // Same Windows entry-point caveat as stubUnresolvable above. The
      // pluginData guard breaks the b.resolve() re-entry below.
      if (a.kind === 'entry-point' || a.pluginData?.viaBundleDeps) return;
      if (isBuiltin(a.path)) return { path: a.path, external: true };
      if (/^[a-z][a-z0-9+.-]*:/i.test(a.path)) return { path: a.path, external: true };
      if (/^react(-dom)?(\/|$)|^react-is$|^scheduler$|^@storybook\//.test(a.path)) return { path: a.path, external: true };
      // Delegate to esbuild's own resolver: it resolves from the importer's
      // dir (so non-hoisted pnpm/yarn-berry layouts work) and honors the
      // `import` export-condition (so ESM-only deps work) — neither of which
      // createRequire(...).resolve handles. Stub only if esbuild can't either.
      const r = await b.resolve(a.path, { resolveDir: a.resolveDir, kind: a.kind, pluginData: { viaBundleDeps: true } });
      if (!r.errors.length) return r;
      console.error(`  ! stubbed unresolvable (bundleDeps): ${a.path}`);
      return { path: a.path, namespace: 'stub-unresolvable' };
    });
    b.onLoad({ filter: /.*/, namespace: 'stub-unresolvable' }, () => ({
      contents: 'module.exports=Object.create(null);', loader: 'js',
    }));
  },
};

export const nodeTranspile = (entry, out, shared = {}, { bundleDeps = false } = {}) =>
  build({
    entryPoints: [entry], outfile: out, bundle: true, format: 'esm',
    platform: 'node', jsx: 'automatic',
    plugins: [bundleDeps ? bundleDepsResolve : stubUnresolvable(out, shared)],
    // The bundleDeps output is ESM but bundles CJS deps that may
    // `require('react')` (kept external above) — esbuild rewrites those to a
    // `__require` shim that throws unless a real `require` is in scope.
    banner: bundleDeps ? { js: "import { createRequire as __cR } from 'node:module'; const require = __cR(import.meta.url);" } : undefined,
    loader: {
      '.css': 'empty', '.scss': 'empty', '.less': 'empty', '.js': 'jsx',
      '.svg': 'text', '.png': 'text', '.jpg': 'empty', '.jpeg': 'empty', '.gif': 'empty', '.webp': 'empty',
      '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.otf': 'empty', '.eot': 'empty',
    },
    // Build-time constants some DS source trees reference bare.
    define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });

// Package-shape story enrichment: for each component with a `storiesPath`,
// transpile + import that single file and set `c.storyIds` from composeStories.
export async function enrichFromStories(components, { nodeModules, out }) {
  const tmpDir = join(out, '.node-extract');
  mkdirSync(tmpDir, { recursive: true });
  installBrowserStubs();
  // Deferred throws (setTimeout/microtask at import time) must not kill us.
  const swallow = (e) => console.error(`  ! story enrich (async): ${String(e).split('\n')[0]}`);
  process.on('uncaughtException', swallow);
  process.on('unhandledRejection', swallow);
  const sb = await importStorybookReact({ nodeModules });
  const composeStories = sb?.composeStories ?? null;
  if (!composeStories) console.error('  ! @storybook/react not importable — story enrichment skipped');
  let hits = 0;
  const shared = {};
  if (composeStories) {
    for (const c of components) {
      if (!c.storiesPath || !existsSync(c.storiesPath)) continue;
      const outFile = join(tmpDir, createHash('sha256').update(c.storiesPath).digest('hex').slice(0, 12) + '.mjs');
      try {
        let mod;
        try {
          await nodeTranspile(c.storiesPath, outFile, shared);
          mod = await import(pathToFileURL(outFile).href);
        } catch (e1) {
          console.error(`  · story enrich retry (bundled deps): initial import failed: ${String(e1?.message ?? e1)}`);
          // Externalized deps whose graph Node can't load natively (.json
          // without an import attribute, raw .css, .ts/.tsx workspace source)
          // throw at import time — retry once with deps bundled through
          // esbuild's loaders. Only the failing story pays the second build.
          const retryOut = outFile.replace(/\.mjs$/, '.deps.mjs');
          await nodeTranspile(c.storiesPath, retryOut, shared, { bundleDeps: true });
          mod = await import(pathToFileURL(retryOut).href);
          console.error(`  · story enrich retry (bundled deps): ${c.storiesPath.split('/').pop()}`);
        }
        if (!mod.default) continue;
        // Skip stories the DS itself marks deprecated/hidden — a v1 story
        // whose export no longer matches the v2 .d.ts would render the wrong
        // thing in the preview.
        const metaComp = mod.default?.component?.displayName ?? mod.default?.component?.name;
        if (metaComp && metaComp !== c.name) continue;
        const storyIds = [];
        const argsById = new Map();
        const raw = readFileSync(c.storiesPath, 'utf8');
        for (const [exportName, S] of Object.entries(composeStories(mod))) {
          if (exportName.startsWith('_')) continue;
          const tags = S.tags ?? [];
          if (tags.includes('!dev') || tags.includes('deprecated') || S.parameters?.deprecated) continue;
          const id = S.id ?? `${c.name.toLowerCase()}--${exportName.toLowerCase()}`;
          storyIds.push({ id, name: S.storyName ?? exportName });
          // CSF3 `render` fn with empty .args → extract JSX source for
          // .prompt.md + pull text children for the preview.
          const hasArgs = S.args && Object.keys(S.args).length > 0;
          const renderSource = hasArgs ? null : extractRenderSource(raw, exportName, c.name);
          argsById.set(id, { args: S.args, renderSource });
        }
        if (storyIds.length) {
          c.storyIds = storyIds;
          c.argsById = argsById;
          hits++;
        }
      } catch (e) {
        // per-file best-effort — one broken stories file doesn't kill the rest
        const msg = e?.errors?.[0]?.text ?? e?.message ?? String(e);
        console.error(`  ! story enrich failed: ${c.storiesPath}: ${String(msg).split('\n')[0]}`);
      }
    }
    console.error(`  story enrich: ${hits}/${components.filter((c) => c.storiesPath).length} files extracted`);
  }
  await new Promise((r) => setTimeout(r, 250));
  process.off('uncaughtException', swallow);
  process.off('unhandledRejection', swallow);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}
