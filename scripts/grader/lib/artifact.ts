import fs from "node:fs";
import path from "node:path";

export interface ArtifactSet {
  /** Files under <logDir>/artifacts/extensions/ plus strays promoted as extensions. */
  extensions: string[];
  /** Files under <logDir>/artifacts/child-tools/ plus strays promoted as child-tools. */
  childTools: string[];
  /** Any stray .ts files that weren't promoted. */
  strays: string[];
  /** Union of extensions + childTools. */
  all: string[];
  /** Whitespace-collapsed concatenation of extensions (for blob checks). */
  extBlob: string;
  /** Whitespace-collapsed concatenation of extensions + childTools. */
  allBlob: string;
  /** Were artifacts at canonical paths? False if any stray was promoted. */
  layoutOk: boolean;
  layoutNotes: string[];
}

export interface SpawnInvocation {
  /** Raw source text of the spawn("pi", [...]) call's arguments array. */
  argsBlock: string;
  /** Identifiers appearing after each "-e" in the spawn args, in order. */
  eFlagIdents: string[];
  /** Resolved component filenames for each "-e" ident, in order. */
  eFlagComponents: string[];
  /** Value of the --tools allowlist, if found (CSV). */
  toolsCsv: string | null;
  /** Tokens from toolsCsv. */
  tools: string[];
  /** Mode from --mode arg (json|rpc|null). */
  mode: "json" | "rpc" | null;
  /** Whether --no-extensions was passed. */
  noExtensions: boolean;
  /** Whether --no-session was passed. */
  noSession: boolean;
  /** Whether --thinking off was passed. */
  thinkingOff: boolean;
}

export type ClassifyStray = (path: string, src: string) => "ext" | "child" | "ignore";

export function discoverArtifacts(logDir: string, classify: ClassifyStray = classifyStrayDefault): ArtifactSet {
  const artDir = path.join(logDir, "artifacts");
  const extDir = path.join(artDir, "extensions");
  const childDir = path.join(artDir, "child-tools");
  const strayDir = path.join(artDir, "stray");

  const extensions = findTsFiles(extDir);
  const childTools = findTsFiles(childDir);
  const rawStrays = findTsFiles(strayDir);

  const strays: string[] = [];
  const layoutNotes: string[] = [];
  let layoutOk = true;

  for (const s of rawStrays) {
    const src = safeRead(s);
    const kind = classify(s, src);
    const rel = path.relative(strayDir, s);
    if (kind === "ext") {
      extensions.push(s);
      layoutOk = false;
      layoutNotes.push(`extension found outside .pi/extensions: ${rel}`);
    } else if (kind === "child") {
      childTools.push(s);
      layoutOk = false;
      layoutNotes.push(`child-tool found outside .pi/child-tools: ${rel}`);
    } else {
      strays.push(s);
    }
  }

  const all = [...extensions, ...childTools];
  const extBlob = collapseBlob(extensions);
  const allBlob = collapseBlob(all);
  return { extensions, childTools, strays, all, extBlob, allBlob, layoutOk, layoutNotes };
}

export function classifyStrayDefault(_p: string, src: string): "ext" | "child" | "ignore" {
  if (/registerCommand/.test(src)) return "ext";
  if (/registerTool/.test(src)) return "child";
  return "ignore";
}

function findTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
    }
  }
  return out.sort();
}

function safeRead(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function collapseBlob(files: string[]): string {
  return files.map(safeRead).join(" ").replace(/\s+/g, " ");
}

/**
 * Parse all spawn("pi", [...]) invocations from an extension's source.
 * Uses regex to find the spawn call and brace-balance to extract the
 * arguments array. AST-free on purpose — string scanning tolerates the
 * formatting variations models emit.
 *
 * Fallback: if a spawn call uses a variable for args (e.g.
 * `spawn("pi", fullArgs, ...)`), the inline-array extractor misses it.
 * We then count spawn call sites and synthesize one SpawnInvocation
 * per call by globally scanning the source for -e/--tools/--mode
 * literals. This is less precise (can't tell which spawn a literal
 * belongs to) but catches the idiom where args are built in pieces.
 */
export function findSpawnInvocations(src: string): SpawnInvocation[] {
  const out: SpawnInvocation[] = [];
  const spawnRe = /spawn\s*\(\s*["']pi["']\s*,\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = spawnRe.exec(src))) {
    const start = m.index + m[0].length - 1;
    const block = extractBracketed(src, start, "[", "]");
    if (!block) continue;
    out.push(parseSpawnArgs(src, block));
  }
  if (out.length > 0) return out;

  // Fallback: count spawn("pi", ...) call sites at all (not just inline).
  const anySpawnRe = /spawn\s*\(\s*["']pi["']\s*,/g;
  const spawnCount = (src.match(anySpawnRe) ?? []).length;
  if (spawnCount === 0) return out;

  const global = globalScan(src);
  // Emit one SpawnInvocation per spawn site; they'll all carry the same
  // globally-scanned data. Per-spawn attribution isn't possible at the
  // source-string level when args are built via variables.
  for (let i = 0; i < spawnCount; i++) out.push(global);
  return out;
}

function globalScan(src: string): SpawnInvocation {
  const eFlagIdents: string[] = [];
  const eArgRe = /["']-e["']\s*,\s*(?:["']([^"']+)["']|([A-Za-z_$][A-Za-z0-9_$]*))/g;
  let em: RegExpExecArray | null;
  while ((em = eArgRe.exec(src))) eFlagIdents.push(em[1] ?? em[2]);
  const eFlagComponents = eFlagIdents.map((id) => {
    if (id.endsWith(".ts")) return id;
    return resolveIdentToComponent(src, id) ?? id;
  });

  const toolsMatch = /["']--tools["']\s*,\s*["']([^"']+)["']/.exec(src);
  const toolsCsv = toolsMatch ? toolsMatch[1] : null;
  const tools = toolsCsv ? toolsCsv.split(",").map((t) => t.trim()).filter(Boolean) : [];

  const modeMatch = /["']--mode["']\s*,\s*["'](json|rpc)["']/.exec(src);
  const mode = (modeMatch ? modeMatch[1] : null) as "json" | "rpc" | null;

  const noExtensions = /["']--no-extensions["']/.test(src);
  const noSession = /["']--no-session["']/.test(src);
  const thinkingOff = /["']--thinking["']\s*,\s*["']off["']/.test(src);

  return {
    argsBlock: "",
    eFlagIdents,
    eFlagComponents,
    toolsCsv,
    tools,
    mode,
    noExtensions,
    noSession,
    thinkingOff,
  };
}

/**
 * Extract the substring between matching brackets starting at `startIdx`
 * (which must point at an `open` char). Returns null if unbalanced.
 */
function extractBracketed(src: string, startIdx: number, open: string, close: string): string | null {
  if (src[startIdx] !== open) return null;
  let depth = 0;
  let inString: string | null = null;
  let escape = false;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(startIdx + 1, i);
    }
  }
  return null;
}

function parseSpawnArgs(fullSrc: string, argsBlock: string): SpawnInvocation {
  const tokens = tokenizeArgs(argsBlock);
  const eFlagIdents: string[] = [];
  let toolsCsv: string | null = null;
  let mode: "json" | "rpc" | null = null;
  let noExtensions = false;
  let noSession = false;
  let thinkingOff = false;

  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (t.kind === "string" && t.value === "-e" && next) {
      // The value after -e may be an identifier (variable name) or a string literal.
      if (next.kind === "ident") eFlagIdents.push(next.value);
      else if (next.kind === "string") eFlagIdents.push(next.value);
      i++;
      continue;
    }
    if (t.kind === "string" && t.value === "--tools" && next && next.kind === "string") {
      toolsCsv = next.value;
      i++;
      continue;
    }
    if (t.kind === "string" && t.value === "--mode" && next && next.kind === "string") {
      if (next.value === "json" || next.value === "rpc") mode = next.value;
      i++;
      continue;
    }
    if (t.kind === "string" && t.value === "--thinking" && next && next.kind === "string") {
      if (next.value === "off") thinkingOff = true;
      i++;
      continue;
    }
    if (t.kind === "string" && t.value === "--no-extensions") noExtensions = true;
    if (t.kind === "string" && t.value === "--no-session") noSession = true;
  }

  const eFlagComponents = eFlagIdents.map((id) => resolveIdentToComponent(fullSrc, id) ?? id);
  const tools = toolsCsv ? toolsCsv.split(",").map((t) => t.trim()).filter(Boolean) : [];

  return {
    argsBlock,
    eFlagIdents,
    eFlagComponents,
    toolsCsv,
    tools,
    mode,
    noExtensions,
    noSession,
    thinkingOff,
  };
}

type ArgToken = { kind: "string"; value: string } | { kind: "ident"; value: string } | { kind: "other" };

/**
 * Walk the spawn args block and classify each comma-separated element as
 * a string literal, an identifier, or something else. This is not a full
 * JS parser — nested expressions or method calls are returned as "other".
 */
function tokenizeArgs(src: string): ArgToken[] {
  const out: ArgToken[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch) || ch === ",") {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const start = i + 1;
      i++;
      let value = "";
      while (i < n) {
        const c = src[i];
        if (c === "\\") {
          value += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        value += c;
        i++;
      }
      out.push({ kind: "string", value: unescape(value) });
      // Skip trailing non-token chars up to comma.
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const ident = src.slice(i, j);
      i = j;
      // If followed by a paren/dot/brace/bracket, it's a call or member access — "other".
      while (i < n && /\s/.test(src[i])) i++;
      if (i < n && /[(.\[{]/.test(src[i])) {
        // Consume balanced call/member expression crudely.
        while (i < n && src[i] !== "," && src[i] !== "]") i++;
        out.push({ kind: "other" });
      } else {
        out.push({ kind: "ident", value: ident });
      }
      continue;
    }
    // Unknown token — consume up to next comma.
    while (i < n && src[i] !== ",") i++;
    out.push({ kind: "other" });
  }
  return out;
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/**
 * Given an identifier used after -e, find its const/let/var assignment
 * in the source and return the referenced component filename (if any).
 * Looks for `.ts` references inside string literals near the binding.
 */
function resolveIdentToComponent(src: string, ident: string): string | null {
  const re = new RegExp(`(?:const|let|var)\\s+${escapeRe(ident)}\\s*=\\s*([^;]+);`, "m");
  const m = re.exec(src);
  if (!m) {
    // Fallback: any literal .ts reference with the ident in context.
    const ctx = findContext(src, ident);
    return extractComponentFilename(ctx);
  }
  return extractComponentFilename(m[1]);
}

function findContext(src: string, ident: string): string {
  const re = new RegExp(`.{0,200}${escapeRe(ident)}.{0,200}`, "g");
  const chunks = src.match(re);
  return chunks ? chunks.join("\n") : "";
}

function extractComponentFilename(s: string): string | null {
  // Match a component basename at a path/quote/start boundary, with a
  // quote/paren/comma/whitespace/EOS on the trailing side. Handles both
  // quote-bounded literals ("cwd-guard.ts") and filenames embedded in
  // an absolute-path literal ("/abs/path/components/cwd-guard.ts").
  const re = /(?:^|[\s"'`/\\])([a-z][a-z0-9-]+\.ts)(?=["'`)\s,]|$)/i;
  const m = re.exec(s);
  return m ? m[1] : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Shape of a generated extension's use of `pi-sandbox/.pi/lib/delegate.ts`
 * (Phase 2.2 onward). `delegateHandles` is the set of components whose
 * rail checks can be trusted to `delegate()`'s implementation rather
 * than to inline extension code — every component that is both imported
 * (from `../components/<name>.ts`) and covered by the `delegate()` call
 * site falls into this set. Review + run-deferred-writer are typically
 * *not* in this set because the orchestrator's RPC loop imports their
 * harvesters but drives its own spawn / event loop.
 */
export interface DelegateUsage {
  usesDelegate: boolean;
  importedComponents: Set<string>;
  delegateHandles: Set<string>;
}

/**
 * Detect whether the extension calls `delegate(...)` from the shared
 * runtime and which components it imports from `../components/*.ts`.
 * Regex-based on purpose — composer output varies in formatting and an
 * AST would fight with every new model.
 *
 * `delegateHandles` is conservative: a component is included only when
 * it is imported *and* its identifier appears inside a `delegate(...)`
 * call's `components: [...]` array — either directly or via a locally-
 * defined wrapper that references it (the `stageHook` pattern used by
 * the RPC orchestrator's drafter spawn).
 */
export function findDelegateUsage(src: string): DelegateUsage {
  const usesDelegate = /\bdelegate\s*\(/.test(src);

  const importedComponents = new Set<string>();
  const identToComponent = new Map<string, string>();
  const importRe =
    /import\s*\{\s*parentSide\s+as\s+([A-Z_][A-Z0-9_]*)[^}]*\}\s*from\s*["'][^"']*components\/([a-z-]+)\.ts["']/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(src))) {
    importedComponents.add(im[2]);
    identToComponent.set(im[1], im[2]);
  }

  const delegateHandles = new Set<string>();
  if (usesDelegate) {
    const delegateCallRe = /\bdelegate\s*\(/g;
    let dm: RegExpExecArray | null;
    while ((dm = delegateCallRe.exec(src))) {
      // Pull out the `components: [...]` array if present within the
      // call argument (bounded lookahead; composer output is compact).
      const after = src.slice(dm.index, dm.index + 4000);
      const cm = /components\s*:\s*\[([^\]]+)\]/.exec(after);
      if (!cm) continue;
      const items = cm[1].split(",").map((s) => s.trim()).filter(Boolean);
      for (const item of items) {
        const idMatch = /[A-Za-z_$][A-Za-z0-9_$]*/.exec(item);
        if (!idMatch) continue;
        const directComponent = identToComponent.get(idMatch[0]);
        if (directComponent) {
          delegateHandles.add(directComponent);
          continue;
        }
        // Fallback: the array element is a locally-defined identifier
        //(camelCase or PascalCase) that wraps an imported component —
        // e.g. the orchestrator's `stageHook = { ...STAGE_WRITE, ... }`.
        // Scan the source for the ident's binding body and any
        // imported UPPER_CASE ident it spreads/references.
        const wrapped = resolveWrappedComponent(src, idMatch[0], identToComponent);
        if (wrapped) delegateHandles.add(wrapped);
      }
    }
  }

  return { usesDelegate, importedComponents, delegateHandles };
}

function resolveWrappedComponent(
  src: string,
  ident: string,
  identToComponent: Map<string, string>,
): string | null {
  // Find the binding body: `const <ident> = ...;`. Narrow the scan
  // window to the bound VALUE (stop at the first bare `;` that isn't
  // inside nested braces/brackets/parens/strings) so we don't accidentally
  // match an import referenced later in the file.
  const bindRe = new RegExp(
    `(?:const|let|var)\\s+${ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*`,
  );
  const m = bindRe.exec(src);
  if (!m) return null;
  const valueStart = m.index + m[0].length;
  const value = extractBindingValue(src, valueStart);
  if (!value) return null;
  for (const [upperIdent, compName] of identToComponent) {
    const re = new RegExp(`\\b${upperIdent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(value)) return compName;
  }
  return null;
}

function extractBindingValue(src: string, start: number): string | null {
  let i = start;
  let depth = 0;
  let inString: string | null = null;
  let escape = false;
  while (i < src.length) {
    const ch = src[i];
    if (escape) {
      escape = false;
      i++;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      i++;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === ";" && depth === 0) return src.slice(start, i);
    i++;
  }
  return src.slice(start);
}

/**
 * Find the slash-command slug from the first registerCommand call in any
 * extension file. Returns null if no match.
 */
export function extractCommandName(extensionFiles: string[]): string | null {
  for (const f of extensionFiles) {
    const src = safeRead(f);
    const m = /pi\.registerCommand\s*\(\s*["']([a-zA-Z0-9_-]+)["']/.exec(src);
    if (m) return m[1];
  }
  return null;
}
