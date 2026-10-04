import type { ExtractionRule, PaginationConfig, ScrapeMode, ScrapeTarget } from './core/types.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface CliArgs {
  /** First `--url`; kept for single-URL callers. */
  url: string;
  /** Every `--url` in order (repeat the flag to scrape a list). Same extraction and pagination for each. */
  urls: string[];
  mode: ScrapeMode;
  selector?: string;
  jsonPath?: string;
  next: boolean;
  page: boolean;
  cursor?: string;
  nextCursorPath?: string;
  maxPages?: number;
  maxItems?: number;
  concurrency: number;
  /** Write `{ stats, items }` JSON here instead of printing it. */
  output?: string;
  /** Allow `--output` to replace an existing file. */
  overwrite: boolean;
}

export type ParsedCli =
  | { kind: 'help' }
  | { kind: 'run'; args: CliArgs };

/** Thrown for invalid command-line input; the CLI prints the message plus usage. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

// ─── Constants ────────────────────────────────────────────────────────

export const DEFAULT_CLI_CONCURRENCY = 8;
const MODES: readonly ScrapeMode[] = ['auto', 'html', 'json'];

// ─── Parsing ──────────────────────────────────────────────────────────

/**
 * Parses CLI arguments. Pure: no I/O and no `process.exit`, so it can be
 * unit-tested. Invalid input throws `CliUsageError`.
 */
export function parseArgs(argv: readonly string[]): ParsedCli {
  const urls: string[] = [];
  const args: Omit<CliArgs, 'url' | 'urls'> = { mode: 'auto', next: false, page: false, concurrency: DEFAULT_CLI_CONCURRENCY, overwrite: false };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;

    // Flags that take a value consume the next argv entry.
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new CliUsageError(`${flag} requires a value`);
      }
      i += 1;
      return next;
    };

    switch (flag) {
      case '--url': urls.push(value()); break;
      case '--mode': args.mode = parseMode(value()); break;
      case '--selector': args.selector = value(); break;
      case '--json-path': args.jsonPath = value(); break;
      case '--next': args.next = true; break;
      case '--page': args.page = true; break;
      case '--cursor': args.cursor = value(); break;
      case '--next-cursor-path': args.nextCursorPath = value(); break;
      case '--max-pages': args.maxPages = parsePositiveInt(flag, value()); break;
      case '--max-items': args.maxItems = parsePositiveInt(flag, value()); break;
      case '--concurrency': args.concurrency = parsePositiveInt(flag, value()); break;
      case '--output': args.output = value(); break;
      case '--overwrite': args.overwrite = true; break;
      case '-h':
      case '--help':
        return { kind: 'help' };
      default:
        throw new CliUsageError(`Unknown argument: ${flag}`);
    }
  }

  const url = urls[0];
  if (url === undefined) throw new CliUsageError('--url is required');

  if (args.overwrite && args.output === undefined) {
    throw new CliUsageError('--overwrite requires --output');
  }

  if (args.selector && args.jsonPath) {
    throw new CliUsageError('Use either --selector or --json-path, not both');
  }

  const paginationFlags = [args.next, args.page, args.cursor !== undefined].filter(Boolean).length;
  if (paginationFlags > 1) {
    throw new CliUsageError('Use only one of --next, --page, --cursor');
  }

  return { kind: 'run', args: { url, urls, ...args } };
}

/** Builds the single `ScrapeTarget` described by the CLI flags. */
export function buildTarget(args: CliArgs): ScrapeTarget {
  const extraction: ExtractionRule | undefined = args.selector
    ? { type: 'html', selector: args.selector }
    : args.jsonPath
      ? { type: 'json', path: args.jsonPath }
      : undefined;

  const pagination: PaginationConfig | undefined = args.next
    ? { mode: 'next-link', maxPages: args.maxPages }
    : args.page
      ? { mode: 'page', maxPages: args.maxPages ?? 50 }
      : args.cursor
        ? { mode: 'cursor', cursorParam: args.cursor, nextCursorPath: args.nextCursorPath ?? 'next_cursor', maxPages: args.maxPages ?? 50 }
        : undefined;

  return { url: args.url, mode: args.mode, extraction, pagination };
}

/** One target per `--url`, all sharing the extraction and pagination built by `buildTarget`. */
export function buildTargets(args: CliArgs): ScrapeTarget[] {
  const template = buildTarget(args);
  return args.urls.map((url) => ({ ...template, url }));
}

export function usage(): string {
  return `Universal scraper CLI

Examples:
  pnpm scrape -- --url https://example.com
  pnpm scrape -- --url https://api.example.com/products --mode json --json-path products
  pnpm scrape -- --url https://example.com/products --selector .product --next --max-pages 10
  pnpm scrape -- --url https://example.com/a --url https://example.com/b --output out/pages.json

Options:
  --url <url>                repeat to scrape several URLs with the same options
  --mode auto|html|json      (default: auto; inferred from --selector / --json-path)
  --selector <css-selector>
  --json-path <a.b.c>
  --next                     follow rel=next / common next links
  --page                     follow page=1,2,3...
  --cursor <param>           follow a JSON cursor parameter
  --next-cursor-path <path>  cursor value path in JSON (default: next_cursor)
  --max-pages <n>
  --max-items <n>
  --concurrency <n>          (default: ${DEFAULT_CLI_CONCURRENCY})
  --output <file.json>       write { stats, items } JSON to this file instead of stdout;
                             missing parent directories are created
  --overwrite                replace an existing --output file (otherwise it is an error)
  -h, --help

Exit codes: 0 success, 1 scrape or output write failed, 2 invalid arguments
            or --output already exists without --overwrite`;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function parseMode(value: string): ScrapeMode {
  if ((MODES as readonly string[]).includes(value)) return value as ScrapeMode;
  throw new CliUsageError(`--mode must be one of ${MODES.join('|')}, got "${value}"`);
}

function parsePositiveInt(flag: string, value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new CliUsageError(`${flag} must be a positive integer, got "${value}"`);
  }
  return Number(value);
}
