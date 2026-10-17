import { createProcessor } from "@mdx-js/mdx";
import {
  parseRankItems,
  parseStatItems,
} from "~/@/components/mdx/article-figure-data";

type PositionedNode = {
  type: string;
  name?: string | null;
  children?: PositionedNode[];
  attributes?: {
    type: string;
    name?: string;
    value?: unknown;
  }[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
};

const processor = createProcessor();

function stringAttribute(node: PositionedNode, name: string): string | undefined {
  const attribute = node.attributes?.find(
    (item) => item.type === "mdxJsxAttribute" && item.name === name,
  );
  return typeof attribute?.value === "string" ? attribute.value : undefined;
}

function inlineText(value: string | number): string {
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]]/g, "\\$&");
}

/**
 * Convert author MDX to readable Markdown without executing it. AST source
 * positions preserve native tables, lists, code and prose while replacing
 * figure data and removing JSX wrappers. A syntax error retains the source
 * rather than making the public /llm route fail or silently dropping text.
 */
export function mdxToCleanMarkdown(content: string): string {
  let root: PositionedNode;
  try {
    root = processor.parse(content) as unknown as PositionedNode;
  } catch {
    return content.trim();
  }

  function renderRange(start: number, end: number, children: PositionedNode[]): string {
    let cursor = start;
    let output = "";
    for (const child of children) {
      const childStart = child.position?.start.offset;
      const childEnd = child.position?.end.offset;
      if (
        childStart === undefined || childEnd === undefined ||
        childStart < cursor || childEnd > end
      ) continue;
      output += content.slice(cursor, childStart) + renderNode(child);
      cursor = childEnd;
    }
    return output + content.slice(cursor, end);
  }

  function renderChildren(node: PositionedNode): string {
    const children = node.children ?? [];
    const first = children[0]?.position?.start.offset;
    const last = children[children.length - 1]?.position?.end.offset;
    return first === undefined || last === undefined
      ? ""
      : renderRange(first, last, children).trim();
  }

  function renderNode(node: PositionedNode): string {
    if (
      node.type === "mdxjsEsm" || node.type === "mdxFlowExpression" ||
      node.type === "mdxTextExpression"
    ) return "";

    if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
      if (node.name === "script" || node.name === "style" || node.name === "RegisterEmail") {
        return "";
      }
      if (node.name === "img") {
        const alt = stringAttribute(node, "alt");
        return alt ? `[${inlineText(alt)}]` : "";
      }

      const title = stringAttribute(node, "title");
      const heading = title ? `**${inlineText(title)}**\n\n` : "";
      const items = stringAttribute(node, "items");
      if (items !== undefined && (node.name === "GraphStat" || node.name === "GraphRank")) {
        try {
          const rows = node.name === "GraphStat"
            ? parseStatItems(items).map((item) =>
              `- ${inlineText(item.value)} ${inlineText(item.label)}${item.hint ? ` — ${inlineText(item.hint)}` : ""}`,
            )
            : parseRankItems(items).map((item) =>
              `- ${inlineText(item.display ?? item.value)} ${inlineText(item.label)}`,
            );
          return heading + rows.join("\n");
        } catch {
          // An invalid figure must not take the plain-text article offline.
          return heading + renderChildren(node);
        }
      }

      const body = renderChildren(node);
      if (!body) return "";
      return node.type === "mdxJsxFlowElement" ? heading + body : body;
    }

    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return start === undefined || end === undefined
      ? ""
      : renderRange(start, end, node.children ?? []);
  }

  return renderRange(0, content.length, root.children ?? [])
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
