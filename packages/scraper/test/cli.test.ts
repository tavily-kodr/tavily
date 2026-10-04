import { describe, expect, it } from 'vitest';
import { CliUsageError, buildTarget, buildTargets, parseArgs } from '../src/cli-args.js';

function run(argv: string[]) {
  const parsed = parseArgs(argv);
  if (parsed.kind !== 'run') throw new Error('expected run');
  return parsed.args;
}

describe('CLI argument parsing', () => {
  it('parses a full set of flags', () => {
    const args = run(['--url', 'https://a.test/x', '--mode', 'json', '--json-path', 'items', '--cursor', 'c', '--max-pages', '3', '--max-items', '10', '--concurrency', '2']);
    expect(args).toMatchObject({ url: 'https://a.test/x', mode: 'json', jsonPath: 'items', cursor: 'c', maxPages: 3, maxItems: 10, concurrency: 2 });
  });

  it('returns help without a url', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
  });

  it('requires --url', () => {
    expect(() => parseArgs([])).toThrow(CliUsageError);
    expect(() => parseArgs([])).toThrow('--url is required');
  });

  it('rejects an unknown mode instead of passing it through', () => {
    expect(() => parseArgs(['--url', 'https://a.test', '--mode', 'xml'])).toThrow(/--mode must be one of auto\|html\|json/);
  });

  it('rejects non-integer and non-positive numeric flags', () => {
    expect(() => parseArgs(['--url', 'https://a.test', '--max-pages', 'abc'])).toThrow(/--max-pages must be a positive integer/);
    expect(() => parseArgs(['--url', 'https://a.test', '--concurrency', '0'])).toThrow(/--concurrency must be a positive integer/);
    expect(() => parseArgs(['--url', 'https://a.test', '--max-items', '1.5'])).toThrow(CliUsageError);
  });

  it('rejects a flag that is missing its value', () => {
    expect(() => parseArgs(['--url'])).toThrow('--url requires a value');
    expect(() => parseArgs(['--url', '--next'])).toThrow('--url requires a value');
  });

  it('rejects unknown arguments and conflicting flags', () => {
    expect(() => parseArgs(['--url', 'https://a.test', '--bogus'])).toThrow('Unknown argument: --bogus');
    expect(() => parseArgs(['--url', 'https://a.test', '--next', '--page'])).toThrow(/only one of --next, --page, --cursor/);
    expect(() => parseArgs(['--url', 'https://a.test', '--selector', '.a', '--json-path', 'b'])).toThrow(/either --selector or --json-path/);
  });

  it('parses --output, --overwrite and repeated --url', () => {
    expect(run(['--url', 'https://a.test'])).toMatchObject({ url: 'https://a.test', urls: ['https://a.test'], overwrite: false });
    expect(run(['--url', 'https://a.test'])).not.toHaveProperty('output');
    expect(run(['--url', 'https://a.test/1', '--url', 'https://a.test/2', '--output', 'out/x.json', '--overwrite'])).toMatchObject({
      url: 'https://a.test/1', urls: ['https://a.test/1', 'https://a.test/2'], output: 'out/x.json', overwrite: true,
    });
    expect(() => parseArgs(['--url', 'https://a.test', '--output'])).toThrow('--output requires a value');
    expect(() => parseArgs(['--url', 'https://a.test', '--overwrite'])).toThrow('--overwrite requires --output');
  });

  it('builds one target per --url with shared extraction and pagination', () => {
    const targets = buildTargets(run(['--url', 'https://a.test/1', '--url', 'https://b.test/2', '--json-path', 'items', '--page']));
    expect(targets).toEqual([
      { url: 'https://a.test/1', mode: 'auto', extraction: { type: 'json', path: 'items' }, pagination: { mode: 'page', maxPages: 50 } },
      { url: 'https://b.test/2', mode: 'auto', extraction: { type: 'json', path: 'items' }, pagination: { mode: 'page', maxPages: 50 } },
    ]);
  });

  it('builds targets with the documented defaults', () => {
    expect(buildTarget(run(['--url', 'https://a.test', '--selector', '.p', '--next']))).toEqual({
      url: 'https://a.test',
      mode: 'auto',
      extraction: { type: 'html', selector: '.p' },
      pagination: { mode: 'next-link', maxPages: undefined },
    });
    expect(buildTarget(run(['--url', 'https://a.test', '--cursor', 'after'])).pagination).toEqual({
      mode: 'cursor', cursorParam: 'after', nextCursorPath: 'next_cursor', maxPages: 50,
    });
    expect(buildTarget(run(['--url', 'https://a.test', '--page'])).pagination).toEqual({ mode: 'page', maxPages: 50 });
  });
});
