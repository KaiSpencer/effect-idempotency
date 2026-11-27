/**
 * Makes the code blocks of the Markdown export read as the rendered page
 * does.
 *
 * Vocs writes each page out as Markdown for agents (`/page.md`,
 * `/llms-full.txt`, the MCP server), and copies a code block as it is in the
 * source. The source of a block is written for the site's compiler, though:
 * it pulls code in with `// [!include ...]`, and a Twoslash block carries
 * setup above `// ---cut---` and `^?` queries that the site hides. This
 * plugin resolves the first and hides the second, so an agent reads the code
 * a person sees.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A Markdown syntax tree node, as far as this plugin reads one. */
interface Node {
  readonly type: string;
  lang?: string | null;
  meta?: string | null;
  value?: string;
  readonly children?: ReadonlyArray<Node>;
}

const srcDir = new URL("./", import.meta.url);

const includePattern = /^\/\/ \[!include ~\/([^\s:\]]+)(?::(\w+))?\]$/;
const regionPattern = /^\s*\/\/ \[!(end)?region (\w+)\]$/;
/** A `^?` query, or a compiler flag such as `// @noErrors`. */
const twoslashOnly = /^\s*\/\/\s*(\^[?|^]|@(?!filename)\w+)/;

/** The lines of a file under `src/`, or of one `[!region]` of it. */
const snippet = (file: string, region: string | undefined): Array<string> => {
  const lines: Array<string> = [];
  let inside = region === undefined;
  const source = readFileSync(fileURLToPath(new URL(file, srcDir)), "utf8");
  for (const line of source.trimEnd().split("\n")) {
    const marker = regionPattern.exec(line);
    if (marker === null) {
      if (inside) lines.push(line);
    } else if (marker[2] === region) {
      inside = marker[1] === undefined;
    }
  }
  return lines;
};

const plain = (code: string, twoslash: boolean): string => {
  let lines = code.split("\n").flatMap((line) => {
    const include = includePattern.exec(line);
    return include === null ? [line] : snippet(include[1]!, include[2]);
  });
  if (twoslash) {
    lines = lines.slice(lines.lastIndexOf("// ---cut---") + 1);
    const after = lines.indexOf("// ---cut-after---");
    if (after !== -1) lines = lines.slice(0, after);
    lines = lines.filter((line) => !twoslashOnly.test(line));
  }
  return lines.join("\n").trim();
};

const visit = (node: Node): void => {
  if (node.type === "code" && node.value !== undefined) {
    const meta = (node.meta ?? "").split(" ");
    node.value = plain(node.value, meta.includes("twoslash"));
    node.meta = meta.filter((word) => word !== "twoslash").join(" ") || null;
  }
  node.children?.forEach(visit);
};

/** A remark plugin for `markdown.outputRemarkPlugins`. */
export const remarkPlainCode = () => visit;
