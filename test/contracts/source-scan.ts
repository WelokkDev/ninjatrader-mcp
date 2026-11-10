import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Text-level readers, since the AddOn only compiles inside NT8.

const REPO = fileURLToPath(new URL("../../", import.meta.url));

export function repoFile(rel: string): string {
  return readFileSync(REPO + rel, "utf-8");
}

function unterminated(what: string, src: string, at: number): never {
  const line = src.slice(0, at).split("\n").length;
  throw new Error(`unterminated ${what} at line ${line} of the C# source`);
}

/** Same-length copy with comments, preprocessor lines and string/char contents blanked, so
 *  brackets and commas can be counted naively. */
function maskCSharp(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number, keepEnds: boolean): void => {
    for (let k = keepEnds ? from + 1 : from; k < (keepEnds ? to : to + 1); k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    // Outside strings and comments, `#` only starts a preprocessor directive.
    if ((c === "/" && next === "/") || c === "#") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length - 1 : end - 1;
      blank(i, stop, false);
      i = stop + 1;
    } else if (c === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close < 0) unterminated("/* comment", src, i);
      blank(i, close + 1, false);
      i = close + 2;
    } else if (c === '"') {
      const verbatim = src[i - 1] === "@";
      let j = i + 1;
      for (;;) {
        if (j >= src.length) unterminated("string", src, i);
        if (!verbatim && src[j] === "\\") j += 2;
        else if (verbatim && src[j] === '"' && src[j + 1] === '"') j += 2;
        else if (src[j] === '"') break;
        else j++;
      }
      blank(i, j, true);
      i = j + 1;
    } else if (c === "'") {
      const j = src.indexOf("'", src[i + 1] === "\\" ? i + 3 : i + 2);
      // The longest char literal is an escape like '\u0041'.
      if (j < 0 || j - i > 7) unterminated("char literal", src, i);
      blank(i, j, true);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

export interface CsMethod {
  name: string;
  start: number;
  end: number;
  takesDictionary: boolean;
}

const CLOSERS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };

export class CSharpSource {
  readonly masked: string;
  readonly methods: CsMethod[] = [];

  constructor(readonly src: string) {
    this.masked = maskCSharp(src);
    const decl =
      /^\t\t(?:(?:private|public|internal|protected|static|async|override|readonly)\s+)+[\w<>[\],.? ]+?\s+(\w+)\s*(?:<[\w\s,]*>)?\s*\(/gm;
    const body = /\s*(?:where\b[^{;=]*)?\{/y;
    for (const m of this.masked.matchAll(decl)) {
      const paren = m.index + m[0].length - 1;
      const close = this.closing(paren);
      body.lastIndex = close + 1;
      if (!body.exec(this.masked)) continue;
      const brace = body.lastIndex - 1;
      this.methods.push({
        name: m[1],
        start: brace,
        end: this.closing(brace),
        takesDictionary: /(?<![\w<])I?Dictionary<string,\s*object>/.test(
          this.src.slice(paren, close),
        ),
      });
    }
  }

  closing(open: number): number {
    const o = this.masked[open];
    const c = CLOSERS[o];
    let depth = 0;
    for (let i = open; i < this.masked.length; i++) {
      if (this.masked[i] === o) depth++;
      else if (this.masked[i] === c && --depth === 0) return i;
    }
    throw new Error(`unbalanced ${o} at offset ${open}`);
  }

  *codeMatches(re: RegExp, from = 0, to = this.src.length): Generator<RegExpMatchArray> {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    for (const m of this.src.slice(from, to).matchAll(new RegExp(re.source, flags))) {
      const at = from + (m.index ?? 0);
      if (this.masked[at] === this.src[at]) yield Object.assign(m, { index: at });
    }
  }

  args(open: number): string[] {
    const close = this.closing(open);
    const parts: string[] = [];
    let depth = 0;
    let from = open + 1;
    for (let i = open + 1; i < close; i++) {
      const ch = this.masked[i];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (ch === "," && depth === 0) {
        parts.push(this.src.slice(from, i).trim());
        from = i + 1;
      }
    }
    parts.push(this.src.slice(from, close).trim());
    return parts;
  }

  method(name: string): CsMethod[] {
    const found = this.methods.filter((m) => m.name === name);
    if (found.length === 0) throw new Error(`no method named ${name}`);
    return found;
  }

  enclosingMethod(at: number): CsMethod {
    const m = this.methods.find((x) => x.start <= at && at <= x.end);
    if (!m) throw new Error(`offset ${at} is outside every method`);
    return m;
  }

  callees(from: number, to: number): string[] {
    const known = new Set(this.methods.map((m) => m.name));
    const names = new Set<string>();
    for (const m of this.codeMatches(/\b([A-Z]\w*)\s*(?:<[\w\s,.<>[\]?]*>)?\s*\(/, from, to)) {
      if (known.has(m[1])) names.add(m[1]);
    }
    return [...names];
  }

  reachable(from: number, to: number, follow: (m: CsMethod) => boolean = () => true): CsMethod[] {
    const seen = new Map<string, CsMethod[]>();
    const queue = this.callees(from, to);
    while (queue.length > 0) {
      const name = queue.pop()!;
      if (seen.has(name)) continue;
      const bodies = this.method(name).filter(follow);
      seen.set(name, bodies);
      for (const b of bodies) queue.push(...this.callees(b.start, b.end));
    }
    return [...seen.values()].flat();
  }
}

export function stringLiteral(text: string): string | null {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(text);
  return m ? m[1] : null;
}

type JsonSchema = {
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
};

function jsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }) as JsonSchema;
}

export function topLevelKeys(schema: z.ZodType): { all: Set<string>; required: Set<string> } {
  const js = jsonSchema(schema);
  return { all: new Set(Object.keys(js.properties ?? {})), required: new Set(js.required) };
}

export function deepKeys(schema: z.ZodType): { keys: Set<string>; hasRecord: boolean } {
  const keys = new Set<string>();
  let hasRecord = false;
  const walk = (s: JsonSchema | boolean | undefined): void => {
    if (!s || typeof s !== "object") return;
    for (const [k, v] of Object.entries(s.properties ?? {})) {
      keys.add(k);
      walk(v);
    }
    if (typeof s.additionalProperties === "object") {
      hasRecord = true;
      walk(s.additionalProperties);
    }
    for (const sub of [s.anyOf, s.oneOf, s.allOf].flat()) walk(sub);
    for (const sub of [s.items].flat()) walk(sub);
  };
  walk(jsonSchema(schema));
  return { keys, hasRecord };
}
