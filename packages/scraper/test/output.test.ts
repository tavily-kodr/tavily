import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutputWriteError, UniversalScraper, assertOutputWritable, writeJsonOutput } from '../src/index.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scraper-output-')); });
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

function response(body: string, contentType = 'application/json') {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

describe('writeJsonOutput', () => {
  it('writes nested JSON that round-trips exactly, with a trailing newline', async () => {
    const data = {
      stats: { pages: 1, failures: [] },
      items: [{ data: { title: 'Café ☕', tags: ['a', 'b'], meta: { deep: { deeper: [1, null, true, { x: -0.5 }] } } } }],
    };
    const path = join(dir, 'out.json');
    const result = await writeJsonOutput(path, data);

    const text = readFileSync(path, 'utf8');
    expect(result).toEqual({ path, bytes: Buffer.byteLength(text) });
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "stats"');
    expect(JSON.parse(text)).toEqual(data);
  });

  it('supports compact output', async () => {
    const path = join(dir, 'compact.json');
    await writeJsonOutput(path, { a: [1, 2] }, { indent: 0 });
    expect(readFileSync(path, 'utf8')).toBe('{"a":[1,2]}\n');
  });

  it('creates missing parent directories', async () => {
    const path = join(dir, 'a', 'b', 'c', 'out.json');
    await writeJsonOutput(path, []);
    expect(readJson(path)).toEqual([]);
  });

  it('never overwrites an existing file silently', async () => {
    const path = join(dir, 'out.json');
    writeFileSync(path, 'precious');

    const error = await writeJsonOutput(path, { new: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutputWriteError);
    expect(error).toMatchObject({ reason: 'exists', code: 'EEXIST', path });
    expect((error as Error).message).toMatch(/already exists/);
    expect(readFileSync(path, 'utf8')).toBe('precious');

    await expect(assertOutputWritable(path)).rejects.toMatchObject({ reason: 'exists' });
    await expect(assertOutputWritable(path, { overwrite: true })).resolves.toBeUndefined();
    await expect(assertOutputWritable(join(dir, 'missing.json'))).resolves.toBeUndefined();
  });

  it('replaces an existing file only with overwrite, leaving no temporary files', async () => {
    const path = join(dir, 'out.json');
    writeFileSync(path, 'old');
    await writeJsonOutput(path, { new: true }, { overwrite: true });
    expect(readJson(path)).toEqual({ new: true });
    expect(readdirSync(dir)).toEqual(['out.json']);
  });

  it('rejects values JSON cannot represent before touching the filesystem', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    for (const value of [circular, { n: 1n }, undefined]) {
      const path = join(dir, 'never', 'out.json');
      await expect(writeJsonOutput(path, value)).rejects.toMatchObject({ name: 'OutputWriteError', reason: 'serialize' });
      expect(existsSync(join(dir, 'never'))).toBe(false);
    }
  });

  it('reports filesystem errors with the path and errno code', async () => {
    await expect(writeJsonOutput('  ', {})).rejects.toMatchObject({ reason: 'filesystem', message: 'Output path is empty' });

    mkdirSync(join(dir, 'a-directory'));
    await expect(writeJsonOutput(join(dir, 'a-directory'), {})).rejects.toMatchObject({ reason: 'filesystem', code: 'EISDIR' });
    await expect(writeJsonOutput(join(dir, 'a-directory'), {}, { overwrite: true })).rejects.toMatchObject({ reason: 'filesystem', code: 'EISDIR' });
    await expect(assertOutputWritable(join(dir, 'a-directory'), { overwrite: true })).rejects.toMatchObject({ code: 'EISDIR', message: expect.stringMatching(/path is a directory/) });
    expect(readdirSync(join(dir, 'a-directory'))).toEqual([]);

    writeFileSync(join(dir, 'a-file'), 'x');
    const error = await writeJsonOutput(join(dir, 'a-file', 'out.json'), {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'filesystem', code: expect.stringMatching(/^(ENOTDIR|EEXIST)$/) });
    expect((error as Error).message).toContain(join(dir, 'a-file'));
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports permission errors without creating files', async () => {
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      await expect(writeJsonOutput(join(locked, 'out.json'), {})).rejects.toMatchObject({ reason: 'filesystem', code: 'EACCES', message: expect.stringMatching(/permission denied/) });
      await expect(writeJsonOutput(join(locked, 'out.json'), {}, { overwrite: true })).rejects.toMatchObject({ code: 'EACCES' });
      expect(readdirSync(locked)).toEqual([]);
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

describe('saving scrape results (mocked HTTP)', () => {
  it('writes the items and stats of a multi-URL scrape', async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => response(JSON.stringify({
      items: [{ id: String(url).endsWith('/a') ? 1 : 2, nested: { list: [{ k: 'v' }] } }],
    }));
    const scraper = new UniversalScraper({ http: { fetchImpl } });
    const result = await scraper.scrape(['https://api.test/a', 'https://api.test/b'].map((url) => ({ url, extraction: { type: 'json' as const, path: 'items' } })));

    const path = join(dir, 'results', 'run.json');
    await writeJsonOutput(path, { stats: result.stats, items: result.items });

    const saved = readJson(path) as { stats: { pages: number; failedPages: number }; items: { sourceUrl: string; data: unknown; contentType: string }[] };
    expect(saved.stats).toMatchObject({ pages: 2, failedPages: 0, items: 2 });
    expect(saved.items.map((i) => [i.sourceUrl, i.data])).toEqual(expect.arrayContaining([
      ['https://api.test/a', { id: 1, nested: { list: [{ k: 'v' }] } }],
      ['https://api.test/b', { id: 2, nested: { list: [{ k: 'v' }] } }],
    ]));
    expect(saved.items.every((i) => i.contentType === 'application/json')).toBe(true);
  });

  it('writes a valid document for an empty result', async () => {
    const fetchImpl = async (): Promise<Response> => response(JSON.stringify({ items: [] }));
    const result = await new UniversalScraper({ http: { fetchImpl } }).scrape([{ url: 'https://api.test/empty', extraction: { type: 'json', path: 'items' } }]);
    const path = join(dir, 'empty.json');
    await writeJsonOutput(path, { stats: result.stats, items: result.items });
    expect(readJson(path)).toMatchObject({ stats: { pages: 1, items: 0 }, items: [] });
  });
});

describe('CLI --output (local server, no live site)', () => {
  let server: Server;
  let base = '';
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ products: [{ id: req.url, specs: { sizes: ['s', 'm'] } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => { server.close(); });

  const cli = (args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { timeout: 30_000 });

  it('saves every --url to the output file, refuses to overwrite it, and replaces it with --overwrite', async () => {
    hits.length = 0;
    const out = join(dir, 'nested', 'dir', 'products.json');
    const args = ['--url', `${base}/a`, '--url', `${base}/b`, '--json-path', 'products', '--output', out];

    const first = await cli(args);
    expect(first.stdout).toMatch(new RegExp(`^wrote 2 items from 2 pages \\(\\d+ bytes\\) to ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`));
    const saved = readJson(out) as { stats: { failedPages: number }; items: { data: unknown }[] };
    expect(saved.stats.failedPages).toBe(0);
    expect(saved.items.map((i) => i.data)).toEqual(expect.arrayContaining([
      { id: '/a', specs: { sizes: ['s', 'm'] } }, { id: '/b', specs: { sizes: ['s', 'm'] } },
    ]));
    expect([...hits].sort()).toEqual(['/a', '/b']);

    // Existing file: exit 2 before any request, file untouched.
    writeFileSync(out, 'keep me');
    hits.length = 0;
    await expect(cli(args)).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('already exists') });
    expect(hits).toEqual([]);
    expect(readFileSync(out, 'utf8')).toBe('keep me');

    await cli([...args, '--overwrite']);
    expect((readJson(out) as { items: unknown[] }).items).toHaveLength(2);
  }, 40_000);

  it('exits 1 with a clear message when the output cannot be written', async () => {
    writeFileSync(join(dir, 'file'), 'x');
    await expect(cli(['--url', `${base}/a`, '--output', join(dir, 'file', 'out.json')]))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/error: Cannot create output directory/) });
  }, 40_000);

  it('still prints to stdout without --output', async () => {
    const { stdout } = await cli(['--url', `${base}/a`, '--json-path', 'products']);
    expect(JSON.parse(stdout)).toMatchObject({ stats: { pages: 1 }, items: [{ data: { id: '/a' } }] });
  }, 40_000);
});
