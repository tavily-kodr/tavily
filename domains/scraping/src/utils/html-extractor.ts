import type { ExtractedHtml, HtmlExtractionOptions } from "../types/scraping.types.js";
import { canonicalizeUrl } from "./url-validator.js";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  bull: "•",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  micro: "µ",
  para: "¶",
  middot: "·",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  sbquo: "‚",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  permil: "‰",
  prime: "′",
  Prime: "″",
  frasl: "/",
  larr: "←",
  uarr: "↑",
  rarr: "→",
  darr: "↓",
  harr: "↔",
  crarr: "↵",
  part: "∂",
  empty: "∅",
  nabla: "∇",
  isin: "∈",
  notin: "∉",
  ni: "∋",
  prod: "∏",
  sum: "∑",
  minus: "−",
  radic: "√",
  prop: "∝",
  infin: "∞",
  ang: "∠",
  and: "∧",
  or: "∨",
  cap: "∩",
  cup: "∪",
  int: "∫",
  there4: "∴",
  sim: "∼",
  cong: "≅",
  asymp: "≈",
  ne: "≠",
  equiv: "≡",
  le: "≤",
  ge: "≥",
  sub: "⊂",
  sup: "⊃",
  nsub: "⊄",
  sube: "⊆",
  supe: "⊇",
  oplus: "⊕",
  otimes: "⊗",
  perp: "⊥",
  sdot: "⋅",
};

/**
 * Decodes named, decimal, and hexadecimal HTML entities.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;

  return text.replace(/&(#?[a-zA-Z0-9]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const rawNum = isHex ? entity.slice(2) : entity.slice(1);
      const code = parseInt(rawNum, isHex ? 16 : 10);
      if (!Number.isNaN(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }

    const lower = entity.toLowerCase();
    if (lower in NAMED_ENTITIES) {
      return NAMED_ENTITIES[lower] ?? match;
    }

    return match;
  });
}

/**
 * Normalizes inline text by collapsing multiple whitespace characters into single spaces.
 */
function cleanInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Parses an HTML attribute string into a dictionary of key-value pairs.
 * Correctly accounts for quotes (' and "), unquoted attributes, and casing.
 */
function parseAttributes(attrString: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let i = 0;
  const len = attrString.length;

  while (i < len) {
    // Skip whitespace and self-closing slashes
    while (i < len && (/\s/.test(attrString[i]!) || attrString[i] === "/")) {
      i++;
    }
    if (i >= len) break;

    // Read attribute name
    const nameStart = i;
    while (i < len && !/[\s=/><]/.test(attrString[i]!)) {
      i++;
    }
    const attrName = attrString.slice(nameStart, i).toLowerCase();
    if (!attrName) {
      i++;
      continue;
    }

    // Skip whitespace before '='
    while (i < len && /\s/.test(attrString[i]!)) {
      i++;
    }

    let attrValue = "";
    if (i < len && attrString[i] === "=") {
      i++; // skip '='

      // Skip whitespace after '='
      while (i < len && /\s/.test(attrString[i]!)) {
        i++;
      }

      if (i < len) {
        const quote = attrString[i];
        if (quote === '"' || quote === "'") {
          i++; // skip opening quote
          const valStart = i;
          while (i < len && attrString[i] !== quote) {
            i++;
          }
          attrValue = attrString.slice(valStart, i);
          if (i < len) i++; // skip closing quote
        } else {
          // Unquoted attribute value
          const valStart = i;
          while (i < len && !/[\s>]/.test(attrString[i]!)) {
            i++;
          }
          attrValue = attrString.slice(valStart, i);
        }
      }
    } else {
      // Boolean attribute without explicit value
      attrValue = attrName;
    }

    attributes[attrName] = decodeHtmlEntities(attrValue);
  }

  return attributes;
}

/**
 * Normalizes the final extracted text:
 * - Trims leading/trailing line whitespace
 * - Collapses internal tabs/spaces
 * - Collapses excess consecutive blank lines to at most one blank line
 */
function normalizeExtractedText(rawText: string): string {
  const lines = rawText.split(/\r?\n/);
  const cleanedLines: string[] = [];
  let consecutiveBlankLines = 0;

  for (const line of lines) {
    const trimmed = line.replace(/[^\S\r\n]+/g, " ").trim();

    if (!trimmed) {
      if (consecutiveBlankLines === 0 && cleanedLines.length > 0) {
        cleanedLines.push("");
        consecutiveBlankLines++;
      }
    } else {
      cleanedLines.push(trimmed);
      consecutiveBlankLines = 0;
    }
  }

  return cleanedLines.join("\n").trim();
}

const RAW_TEXT_TAGS = new Set(["script", "style", "noscript", "svg"]);
const BOILERPLATE_TAGS = new Set(["nav", "header", "footer", "aside"]);
const DOUBLE_BREAK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "blockquote"]);
const SINGLE_BREAK_TAGS = new Set([
  "div",
  "li",
  "ul",
  "ol",
  "tr",
  "section",
  "article",
  "main",
  "figure",
  "figcaption",
  "dl",
  "dt",
  "dd",
  "pre",
  "table",
]);

/**
 * Extracts readable page text, metadata, and outgoing links from raw HTML.
 *
 * @param rawHtml The HTML markup to process.
 * @param pageUrl The base URL of the page used to resolve relative links.
 * @param options Extraction options (e.g., whether to include boilerplate elements).
 */
export function extractHtml(
  rawHtml: string,
  pageUrl: string,
  options: HtmlExtractionOptions = {},
): ExtractedHtml {
  if (typeof rawHtml !== "string" || !rawHtml.trim()) {
    return {
      title: "",
      description: undefined,
      canonicalUrl: undefined,
      language: undefined,
      text: "",
      links: [],
    };
  }

  const html = rawHtml;
  const len = html.length;

  let title = "";
  let metaDescription: string | undefined = undefined;
  let ogTitle: string | undefined = undefined;
  let ogDescription: string | undefined = undefined;
  let canonicalUrl: string | undefined = undefined;
  let language: string | undefined = undefined;

  const discoveredLinks = new Set<string>();
  const textChunks: string[] = [];

  let boilerplateDepth = 0;
  let i = 0;

  const ensureBoundary = (numBreaks: 1 | 2) => {
    const current = textChunks[textChunks.length - 1] ?? "";
    if (!current) return;
    if (numBreaks === 2) {
      if (!current.endsWith("\n\n")) {
        if (current.endsWith("\n")) {
          textChunks.push("\n");
        } else {
          textChunks.push("\n\n");
        }
      }
    } else if (!current.endsWith("\n")) {
      textChunks.push("\n");
    }
  };

  while (i < len) {
    // 1. Comments: <!-- ... -->
    if (html.slice(i, i + 4) === "<!--") {
      const commentEnd = html.indexOf("-->", i + 4);
      i = commentEnd !== -1 ? commentEnd + 3 : len;
      continue;
    }

    // 2. Doctype: <!DOCTYPE ...>
    if (html.slice(i, i + 9).toLowerCase() === "<!doctype") {
      const doctypeEnd = html.indexOf(">", i + 9);
      i = doctypeEnd !== -1 ? doctypeEnd + 1 : len;
      continue;
    }

    // 3. HTML Tags: <...>
    if (html[i] === "<") {
      // Find the tag's closing '>', safely respecting quotes in attributes
      let tagEnd = -1;
      let inQuote: '"' | "'" | null = null;
      for (let j = i + 1; j < len; j++) {
        const char = html[j];
        if (inQuote) {
          if (char === inQuote) {
            inQuote = null;
          }
        } else if (char === '"' || char === "'") {
          inQuote = char;
        } else if (char === ">") {
          tagEnd = j;
          break;
        }
      }

      if (tagEnd === -1) {
        // Unclosed tag: treat remainder as plain text
        break;
      }

      const rawTagContent = html.slice(i + 1, tagEnd).trim();
      const isClosing = rawTagContent.startsWith("/");
      const cleanContent = isClosing ? rawTagContent.slice(1).trim() : rawTagContent;

      const spaceIdx = cleanContent.search(/[\s/]/);
      const tagName = (
        spaceIdx !== -1 ? cleanContent.slice(0, spaceIdx) : cleanContent
      ).toLowerCase();
      const attrString = spaceIdx !== -1 ? cleanContent.slice(spaceIdx) : "";
      const attributes = parseAttributes(attrString);

      // Handle raw-text tags: completely skip contents of script, style, noscript, svg
      if (RAW_TEXT_TAGS.has(tagName) && !isClosing) {
        const closePattern = new RegExp(`</${tagName}\\s*>`, "i");
        const match = closePattern.exec(html.slice(tagEnd + 1));
        if (match) {
          i = tagEnd + 1 + match.index + match[0].length;
        } else {
          i = len;
        }
        continue;
      }

      // Handle <title>
      if (tagName === "title" && !isClosing) {
        const closePattern = /<\/title\s*>/i;
        const match = closePattern.exec(html.slice(tagEnd + 1));
        if (match) {
          const rawTitle = html.slice(tagEnd + 1, tagEnd + 1 + match.index);
          title = cleanInlineText(decodeHtmlEntities(rawTitle));
          i = tagEnd + 1 + match.index + match[0].length;
        } else {
          const rawTitle = html.slice(tagEnd + 1);
          title = cleanInlineText(decodeHtmlEntities(rawTitle));
          i = len;
        }
        continue;
      }

      // Handle <html> language
      if (tagName === "html" && !isClosing) {
        const langCandidate = attributes.lang ?? attributes["xml:lang"];
        if (langCandidate && langCandidate.trim()) {
          language = langCandidate.trim();
        }
      }

      // Handle <meta> tags
      if (tagName === "meta" && !isClosing) {
        const name = attributes.name?.toLowerCase() ?? "";
        const prop = attributes.property?.toLowerCase() ?? "";
        const content = attributes.content?.trim();

        if (content) {
          if (name === "description" && !metaDescription) {
            metaDescription = cleanInlineText(content);
          } else if (
            (prop === "og:description" || name === "twitter:description") &&
            !ogDescription
          ) {
            ogDescription = cleanInlineText(content);
          } else if ((prop === "og:title" || name === "twitter:title") && !ogTitle) {
            ogTitle = cleanInlineText(content);
          }
        }
      }

      // Handle <link rel="canonical">
      if (tagName === "link" && !isClosing) {
        const rel = attributes.rel?.toLowerCase() ?? "";
        const href = attributes.href?.trim();
        if (rel.split(/\s+/).includes("canonical") && href) {
          try {
            const resolved = new URL(href, pageUrl);
            if (resolved.protocol === "http:" || resolved.protocol === "https:") {
              canonicalUrl = canonicalizeUrl(resolved.toString());
            }
          } catch {
            // Ignore unresolvable canonical link
          }
        }
      }

      // Handle <a> links
      if (tagName === "a" && !isClosing && attributes.href) {
        const rawHref = attributes.href.trim();
        if (
          rawHref &&
          !rawHref.startsWith("#") &&
          !rawHref.toLowerCase().startsWith("javascript:") &&
          !rawHref.toLowerCase().startsWith("mailto:") &&
          !rawHref.toLowerCase().startsWith("tel:") &&
          !rawHref.toLowerCase().startsWith("data:")
        ) {
          try {
            const resolved = new URL(rawHref, pageUrl);
            if (resolved.protocol === "http:" || resolved.protocol === "https:") {
              discoveredLinks.add(canonicalizeUrl(resolved.toString()));
            }
          } catch {
            // Ignore unresolvable link
          }
        }
      }

      // Track boilerplate boundaries (nav, header, footer, aside)
      if (BOILERPLATE_TAGS.has(tagName)) {
        if (!isClosing) {
          boilerplateDepth++;
        } else if (boilerplateDepth > 0) {
          boilerplateDepth--;
        }
      }

      // Structural line breaks for text extraction
      if (tagName === "br") {
        textChunks.push("\n");
      } else if (DOUBLE_BREAK_TAGS.has(tagName)) {
        ensureBoundary(2);
      } else if (SINGLE_BREAK_TAGS.has(tagName)) {
        ensureBoundary(1);
      }

      i = tagEnd + 1;
      continue;
    }

    // 4. Regular Text Content
    const nextTag = html.indexOf("<", i);
    const chunkEnd = nextTag !== -1 ? nextTag : len;
    const rawChunk = html.slice(i, chunkEnd);

    if (rawChunk) {
      const isBoilerplate = boilerplateDepth > 0 && !options.includeBoilerplate;
      if (!isBoilerplate) {
        if (!rawChunk.trim()) {
          // Pure inter-tag whitespace: preserve single space if adjacent to non-whitespace
          const last = textChunks[textChunks.length - 1] ?? "";
          if (last && !/[\s\n]$/.test(last)) {
            textChunks.push(" ");
          }
        } else {
          textChunks.push(decodeHtmlEntities(rawChunk));
        }
      }
    }

    i = chunkEnd;
  }

  const finalTitle = title || ogTitle || "";
  const finalDescription = metaDescription || ogDescription || undefined;
  const rawAccumulatedText = textChunks.join("");
  const cleanedText = normalizeExtractedText(rawAccumulatedText);

  return {
    title: finalTitle,
    description: finalDescription,
    canonicalUrl,
    language,
    text: cleanedText,
    links: Array.from(discoveredLinks),
  };
}
