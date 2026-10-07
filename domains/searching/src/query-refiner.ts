import { logger } from "@tavily/logger";

// Common filler/stop phrases ordered by length descending
const FILLER_PHRASES: readonly string[] = [
  "i want to know about",
  "i would like to know",
  "can you tell me about",
  "could you tell me about",
  "please tell me about",
  "i want to find out",
  "i need to find out",
  "i am looking for",
  "i'm looking for",
  "tell me about",
  "search for",
  "find me",
  "look up",
  "what are the",
  "what is the",
  "what are",
  "what is",
  "who is the",
  "who are the",
  "who is",
  "who are",
  "how to do",
  "how do i",
  "how can i",
  "how to",
  "where can i find",
  "where is the",
  "where is",
  "when is the",
  "when is",
  "why is the",
  "why is",
  "why do",
  "why does",
  "please",
] as const;

function buildFillerRegex(): RegExp {
  const escaped = FILLER_PHRASES.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "gi");
}

const FILLER_REGEX = buildFillerRegex();
const TRAILING_PUNCTUATION_REGEX = /[?.!,;:]+$/;
const DUPLICATE_WORD_REGEX = /\b(\w+)(?:\s+\1)+\b/gi;
const MULTI_SPACE_REGEX = /\s{2,}/g;

// Cleans raw query: strips conversational filler phrases, duplicate words, and trailing punctuation
export function refineQuery(rawQuery: string): string {
  const trimmed = rawQuery.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  let refined = trimmed;
  refined = refined.replace(FILLER_REGEX, " ");
  refined = refined.replace(DUPLICATE_WORD_REGEX, "$1");
  refined = refined.replace(TRAILING_PUNCTUATION_REGEX, "");
  refined = refined.replace(MULTI_SPACE_REGEX, " ").trim();

  // If cleaning leaves empty string, retain original query
  if (refined.length === 0) {
    logger.warn("Query refinement produced empty result, using original query", {
      originalQuery: trimmed,
    });
    return trimmed;
  }

  if (refined !== trimmed) {
    logger.debug("Query refined", { original: trimmed, refined });
  }

  return refined;
}
