import crypto from "node:crypto";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/**
 * Creates and configures a TurndownService instance with GitHub Flavored Markdown support.
 */
export function createTurndownService(includeImages = false): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });

  // Apply GFM plugins (tables, strikethrough, task lists)
  try {
    service.use(gfm);
  } catch {
    // If gfm plugin load fails, continue with standard Turndown
  }

  // Remove images if includeImages is false
  if (!includeImages) {
    service.addRule("removeImages", {
      filter: "img",
      replacement: () => "",
    });
  }

  return service;
}

/**
 * Converts cleaned HTML into GitHub Flavored Markdown.
 */
export function htmlToMarkdown(html: string, includeImages = false): string {
  if (!html || !html.trim()) return "";
  const service = createTurndownService(includeImages);
  const markdown = service.turndown(html);
  // Clean multiple blank lines
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Computes a deterministic SHA-256 hash of markdown content.
 */
export function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content.trim(), "utf-8").digest("hex");
}
