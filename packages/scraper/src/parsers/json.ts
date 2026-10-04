/**
 * Parses a JSON string, throwing a descriptive error on failure.
 */
export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('Response is not valid JSON');
  }
}

/**
 * Traverses an object by a dot-separated path (e.g. "data.items").
 * Returns `undefined` if any segment along the path is missing.
 */
export function getJsonPath(value: unknown, path?: string): unknown {
  if (!path) return value;

  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, key) => {
      if (current === null || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[key];
    }, value);
}
