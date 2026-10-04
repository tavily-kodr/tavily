import { UniversalScraper } from './index.js';
import { CliUsageError, buildTargets, parseArgs, usage } from './cli-args.js';
import { OutputWriteError, assertOutputWritable, writeJsonOutput } from './output/write-json.js';

/**
 * Thin CLI over the library for one-off real-URL checks. All parsing lives in
 * `cli-args.ts`; this file only does I/O and sets the exit code.
 */

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs(process.argv.slice(2).filter((arg) => arg !== '--'));
} catch (error) {
  if (error instanceof CliUsageError) fail(`error: ${error.message}\n\n${usage()}`, 2);
  throw error;
}

if (parsed.kind === 'help') {
  console.log(usage());
  process.exit(0);
}

const { args } = parsed;

// Refuse an existing --output file before spending time on the network.
if (args.output !== undefined) {
  try {
    await assertOutputWritable(args.output, { overwrite: args.overwrite });
  } catch (error) {
    if (error instanceof OutputWriteError) fail(`error: ${error.message}`, 2);
    throw error;
  }
}

const scraper = new UniversalScraper({
  http: { concurrency: args.concurrency, timeoutMs: 15_000, retries: 2 },
});

try {
  const result = await scraper.scrape(buildTargets(args), {
    concurrency: args.concurrency,
    maxItems: args.maxItems,
  });
  const document = { stats: result.stats, items: result.items };
  if (args.output === undefined) {
    console.log(JSON.stringify(document, null, 2));
  } else {
    const written = await writeJsonOutput(args.output, document, { overwrite: args.overwrite });
    console.log(`wrote ${result.items.length} items from ${result.stats.pages} pages (${written.bytes} bytes) to ${written.path}`);
  }
} catch (error) {
  fail(`error: ${error instanceof Error ? error.message : String(error)}`, 1);
}
