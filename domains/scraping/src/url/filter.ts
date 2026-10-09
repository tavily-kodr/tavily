/**
 * Converts a wildcard pattern (*, ?) or regex to a RegExp instance.
 */
function toRegExp(pattern: string): RegExp {
  const trimmed = pattern.trim();

  // If pattern is in /regex/flags format
  if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
    const lastSlash = trimmed.lastIndexOf("/");
    const regexBody = trimmed.slice(1, lastSlash);
    const flags = trimmed.slice(lastSlash + 1);
    try {
      return new RegExp(regexBody, flags || "i");
    } catch {
      // Fallback to literal matching if invalid regex
    }
  }

  // Convert wildcard string: * becomes .*, ? becomes .
  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  return new RegExp(`^${escaped}$`, "i");
}

export function matchesPattern(value: string, pattern: string): boolean {
  if (!pattern) return false;
  try {
    const rx = toRegExp(pattern);
    return rx.test(value);
  } catch {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
}

/**
 * Checks if a pathname matches selection/exclusion rules.
 * Precedence: Exclusion rules ALWAYS take precedence over inclusion rules.
 */
export function matchesPathRules(
  pathname: string,
  selectPaths: string[] = [],
  excludePaths: string[] = [],
): boolean {
  // 1. Check exclusions first (Precedence)
  for (const exclude of excludePaths) {
    if (matchesPattern(pathname, exclude)) {
      return false;
    }
  }

  // 2. If no inclusions specified, allow all non-excluded paths
  if (!selectPaths || selectPaths.length === 0) {
    return true;
  }

  // 3. Must match at least one inclusion rule
  for (const select of selectPaths) {
    if (matchesPattern(pathname, select)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a hostname matches domain selection/exclusion rules.
 * Precedence: Exclusion rules ALWAYS take precedence over inclusion rules.
 */
export function matchesDomainRules(
  hostname: string,
  selectDomains: string[] = [],
  excludeDomains: string[] = [],
): boolean {
  const host = hostname.toLowerCase();

  // 1. Check exclusions first
  for (const exclude of excludeDomains) {
    const cleanExclude = exclude.toLowerCase().trim();
    if (
      host === cleanExclude ||
      host.endsWith(`.${cleanExclude}`) ||
      matchesPattern(host, cleanExclude)
    ) {
      return false;
    }
  }

  // 2. If no inclusions specified, allow all non-excluded domains
  if (!selectDomains || selectDomains.length === 0) {
    return true;
  }

  // 3. Must match at least one inclusion rule
  for (const select of selectDomains) {
    const cleanSelect = select.toLowerCase().trim();
    if (
      host === cleanSelect ||
      host.endsWith(`.${cleanSelect}`) ||
      matchesPattern(host, cleanSelect)
    ) {
      return true;
    }
  }

  return false;
}
