import { describe, expect, it } from 'vitest';
import { HttpClient, HttpError, NetworkError, RequestTimeoutError, ResponseTooLargeError, redactUrl } from '../src/index.js';

/** A fetch that never resolves until its signal aborts (simulates a stalled server). */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
}

describe('HttpClient', () => {
  it('retries 500 and succeeds', async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      if (calls < 3) return new Response('', { status: 500 });
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new HttpClient({ retries: 2, baseDelayMs: 1, maxDelayMs: 2, fetchImpl });
    await expect(client.json('https://api.test/x')).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it('does not retry 404', async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => { calls += 1; return new Response('missing', { status: 404 }); };
    const client = new HttpClient({ retries: 3, fetchImpl });
    await expect(client.json('https://api.test/x')).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });

  it('fails fast instead of sleeping when Retry-After exceeds maxRetryAfterMs', async () => {
    let calls = 0;
    const started = Date.now();
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      return new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } });
    };
    const client = new HttpClient({ retries: 3, maxRetryAfterMs: 1_000, fetchImpl });
    const error = await client.text('https://api.test/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(429);
    expect((error as HttpError).message).toMatch(/Retry-After of 3600s exceeds maxRetryAfterMs=1000/);
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('explains invalid and relative URLs', () => {
    expect(() => new HttpClient().resolve('/relative')).toThrow(/Invalid URL "\/relative" \(relative URLs require HttpClientOptions.baseUrl\)/);
    expect(() => new HttpClient({ baseUrl: 'https://a.test' }).resolve('http://[bad')).toThrow(/^Invalid URL "http:\/\/\[bad"$/);
    expect(new HttpClient({ baseUrl: 'https://a.test' }).resolve('/ok')).toBe('https://a.test/ok');
  });

  it('retries a timed-out attempt and succeeds', async () => {
    let calls = 0;
    const fetchImpl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls += 1;
      if (calls === 1) return hang(init);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    };
    const client = new HttpClient({ timeoutMs: 20, retries: 1, baseDelayMs: 1, maxDelayMs: 2, fetchImpl });
    await expect(client.json('https://api.test/slow')).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('throws RequestTimeoutError naming the URL once retries are exhausted', async () => {
    const client = new HttpClient({ timeoutMs: 20, retries: 0, fetchImpl: (_u, init) => hang(init) });
    const error = await client.request('https://api.test/slow').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toBe('Request to https://api.test/slow timed out after 20 ms');
  });

  it('wraps transport failures with the URL and the underlying cause code', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }) });
    };
    const client = new HttpClient({ retries: 0, fetchImpl });
    const error = await client.request('https://api.test/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toBe('Request to https://api.test/x failed: ECONNREFUSED (connect ECONNREFUSED 127.0.0.1:1)');
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  it('omits an empty cause message instead of printing "CODE ()"', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new AggregateError([], ''), { code: 'ETIMEDOUT' }) });
    };
    const client = new HttpClient({ retries: 0, fetchImpl });
    await expect(client.request('https://api.test/x')).rejects.toThrow(/^Request to https:\/\/api\.test\/x failed: ETIMEDOUT$/);
  });

  it('does not retry a caller cancellation', async () => {
    let calls = 0;
    const controller = new AbortController();
    const fetchImpl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => { calls += 1; return hang(init); };
    const client = new HttpClient({ retries: 3, baseDelayMs: 1, maxDelayMs: 2, fetchImpl });
    const pending = client.request('https://api.test/x', { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('cancelled by caller')), 10);
    await expect(pending).rejects.toThrow('cancelled by caller');
    expect(calls).toBe(1);
  });

  it('never exceeds the configured in-flight request limit', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = async (): Promise<Response> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return new Response('ok', { status: 200 });
    };
    const client = new HttpClient({ concurrency: 3, fetchImpl });
    await Promise.all(Array.from({ length: 30 }, (_, i) => client.text(`https://api.test/${i}`)));
    expect(maxActive).toBe(3);
  });

  it('rejects oversized responses declared by Content-Length without reading them', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    });
    const fetchImpl = async (): Promise<Response> => new Response(stream, { status: 200, headers: { 'content-length': '5000000' } });
    const client = new HttpClient({ maxResponseBytes: 1_000_000, fetchImpl });
    const error = await client.text('https://api.test/big').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResponseTooLargeError);
    expect((error as ResponseTooLargeError).receivedBytes).toBe(5_000_000);
    expect(cancelled).toBe(true);
    // Only the stream's own eager prefetch ran; readBody never consumed it.
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it('stops reading a streamed body once it exceeds maxResponseBytes', async () => {
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { chunks += 1; controller.enqueue(new Uint8Array(10_000)); } });
    const fetchImpl = async (): Promise<Response> => new Response(stream, { status: 200 });
    const client = new HttpClient({ maxResponseBytes: 25_000, fetchImpl });
    const error = await client.text('https://api.test/stream').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResponseTooLargeError);
    expect((error as Error).message).toBe('Response from https://api.test/stream exceeds maxResponseBytes=25000 (received at least 30000 bytes)');
    expect(chunks).toBeLessThanOrEqual(4);
  });

  it('reads bodies within the limit and honours the declared charset', async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
    const fetchImpl = async (): Promise<Response> => new Response(latin1, { status: 200, headers: { 'content-type': 'text/html; charset=iso-8859-1' } });
    const client = new HttpClient({ fetchImpl });
    await expect(client.text('https://api.test/latin')).resolves.toBe('café');
  });

  it('redacts credentials and secret query values in error messages', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('nope', { status: 403 });
    const client = new HttpClient({ fetchImpl, sensitiveParams: ['customer_ref'] });
    const url = 'https://user:hunter2@api.test/v1/items?api_key=SECRET123&page=2&X-Access-Token=abc&customer_ref=42';
    const error = (await client.request(url).catch((e: unknown) => e)) as HttpError;
    expect(error).toBeInstanceOf(HttpError);
    expect(error.message).toContain('https://user:REDACTED@api.test/v1/items?api_key=REDACTED&page=2&X-Access-Token=REDACTED&customer_ref=REDACTED');
    expect(error.message).not.toContain('SECRET123');
    expect(error.message).not.toContain('hunter2');
    expect(error.url).not.toContain('SECRET123');
  });

  it('redactUrl leaves ordinary parameters and unparseable input alone', () => {
    expect(redactUrl('https://a.test/x?page=2&q=shoes')).toBe('https://a.test/x?page=2&q=shoes');
    expect(redactUrl('not a url')).toBe('not a url');
  });

  it('limits in-flight requests per host while other hosts keep going', async () => {
    const active = new Map<string, number>();
    let maxPerHost = 0;
    let maxTotal = 0;
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const host = new URL(String(input)).host;
      active.set(host, (active.get(host) ?? 0) + 1);
      maxPerHost = Math.max(maxPerHost, active.get(host) ?? 0);
      maxTotal = Math.max(maxTotal, [...active.values()].reduce((a, b) => a + b, 0));
      await new Promise((r) => setTimeout(r, 10));
      active.set(host, (active.get(host) ?? 0) - 1);
      return new Response('ok');
    };
    const client = new HttpClient({ concurrency: 10, perHost: { concurrency: 1 }, fetchImpl });
    await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => client.text(`https://a.test/${i}`)),
      ...Array.from({ length: 4 }, (_, i) => client.text(`https://b.test/${i}`)),
    ]);
    expect(maxPerHost).toBe(1);
    expect(maxTotal).toBe(2);
  });

  it('spaces request starts to the same host by minIntervalMs', async () => {
    const starts: number[] = [];
    const fetchImpl = async (): Promise<Response> => { starts.push(Date.now()); return new Response('ok'); };
    const client = new HttpClient({ perHost: { minIntervalMs: 20 }, fetchImpl });
    await Promise.all(Array.from({ length: 4 }, (_, i) => client.text(`https://a.test/${i}`)));
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i += 1) {
      expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(15);
    }
  });

  it('cancels a request that is waiting for its host slot', async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => { calls += 1; return new Response('ok'); };
    const client = new HttpClient({ perHost: { minIntervalMs: 10_000 }, fetchImpl });
    await client.text('https://a.test/first');
    const controller = new AbortController();
    const pending = client.text('https://a.test/second', { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('cancelled while rate limited')), 10);
    await expect(pending).rejects.toThrow('cancelled while rate limited');
    expect(calls).toBe(1);
  });

  it('reports every attempt to onRequest with redacted URLs', async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) return new Response('', { status: 503 });
      if (calls === 2) throw new TypeError('fetch failed');
      return new Response('ok', { status: 200 });
    };
    const events: Array<{ attempt: number; status?: number; error?: string; willRetry: boolean; url: string }> = [];
    const client = new HttpClient({
      retries: 2, baseDelayMs: 1, maxDelayMs: 2, fetchImpl,
      onRequest: (event) => { events.push(event); throw new Error('logger bug must be swallowed'); },
    });
    await expect(client.text('https://api.test/x?token=abc')).resolves.toBe('ok');
    expect(events.map(({ attempt, status, error, willRetry }) => ({ attempt, status, error, willRetry }))).toEqual([
      { attempt: 0, status: 503, error: undefined, willRetry: true },
      { attempt: 1, status: undefined, error: 'fetch failed', willRetry: true },
      { attempt: 2, status: 200, error: undefined, willRetry: false },
    ]);
    expect(events[0]?.url).toBe('https://api.test/x?token=REDACTED');
  });

  describe('revalidate', () => {
    function etagServer() {
      const seen: Array<string | null> = [];
      let version = 1;
      const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const sent = new Headers(init?.headers).get('if-none-match');
        seen.push(sent);
        const etag = `W/"v${version}"`;
        if (sent === etag) return new Response(null, { status: 304, headers: { etag } });
        return new Response(`body-v${version}`, { status: 200, headers: { etag, 'content-type': 'text/plain; charset=utf-8' } });
      };
      return { fetchImpl, seen, bump: () => { version += 1; } };
    }

    it('sends If-None-Match and serves a 304 from memory', async () => {
      const server = etagServer();
      const client = new HttpClient({ fetchImpl: server.fetchImpl, revalidate: {} });
      await expect(client.text('https://api.test/x')).resolves.toBe('body-v1');
      await expect(client.text('https://api.test/x')).resolves.toBe('body-v1');
      expect(server.seen).toEqual([null, 'W/"v1"']);
    });

    it('asks for validation with max-age=0 so fetch does not add no-cache', async () => {
      const sent: Array<string | null> = [];
      const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        sent.push(new Headers(init?.headers).get('cache-control'));
        return new Response('x', { status: 200, headers: { etag: '"1"' } });
      };
      const client = new HttpClient({ fetchImpl, revalidate: {} });
      await client.text('https://api.test/x');
      await client.text('https://api.test/x');
      await client.text('https://api.test/x', { headers: { 'cache-control': 'no-store' } });
      expect(sent).toEqual([null, 'max-age=0', 'no-store']);
    });

    it('refreshes the entry when the server returns new content', async () => {
      const server = etagServer();
      const client = new HttpClient({ fetchImpl: server.fetchImpl, revalidate: {} });
      await client.text('https://api.test/x');
      server.bump();
      await expect(client.text('https://api.test/x')).resolves.toBe('body-v2');
      await expect(client.text('https://api.test/x')).resolves.toBe('body-v2');
      expect(server.seen).toEqual([null, 'W/"v1"', 'W/"v2"']);
    });

    it('is off by default and bounded by maxEntries', async () => {
      const off = etagServer();
      const plain = new HttpClient({ fetchImpl: off.fetchImpl });
      await plain.text('https://api.test/x');
      await plain.text('https://api.test/x');
      expect(off.seen).toEqual([null, null]);

      const small = etagServer();
      const bounded = new HttpClient({ fetchImpl: small.fetchImpl, revalidate: { maxEntries: 1 } });
      await bounded.text('https://api.test/a');
      await bounded.text('https://api.test/b'); // evicts /a
      await bounded.text('https://api.test/a');
      expect(small.seen).toEqual([null, null, null]);
    });
  });

  it('warmup swallows failures and still reports elapsed time', async () => {
    const methods: string[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      methods.push(init?.method ?? 'GET');
      return new Response('', { status: 405 });
    };
    const client = new HttpClient({ fetchImpl, retries: 0 });
    const ms = await client.warmup('https://api.test/');
    expect(methods).toEqual(['HEAD']);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  describe('hedge', () => {
    /** First call stalls for `slowMs`, later calls answer after `fastMs`. Tracks aborts. */
    function raceServer(slowMs: number, fastMs: number) {
      const state = { calls: 0, aborted: 0 };
      const fetchImpl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        state.calls += 1;
        const n = state.calls;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response(`call-${n}`)), n === 1 ? slowMs : fastMs);
          init?.signal?.addEventListener('abort', () => { clearTimeout(timer); state.aborted += 1; reject(init.signal?.reason); }, { once: true });
        });
      };
      return { state, fetchImpl };
    }

    it('starts a duplicate after afterMs, uses the faster response and aborts the slow one', async () => {
      const { state, fetchImpl } = raceServer(500, 10);
      const events: boolean[] = [];
      const client = new HttpClient({ fetchImpl, hedge: { afterMs: 30 }, onRequest: (e) => events.push(e.hedged) });
      const started = Date.now();
      await expect(client.text('https://api.test/x')).resolves.toBe('call-2');
      expect(Date.now() - started).toBeLessThan(200);
      expect(state).toEqual({ calls: 2, aborted: 1 });
      expect(events).toEqual([true]);
    });

    it('does not hedge requests that answer before afterMs', async () => {
      const { state, fetchImpl } = raceServer(5, 5);
      const client = new HttpClient({ fetchImpl, hedge: { afterMs: 100 } });
      await expect(client.text('https://api.test/x')).resolves.toBe('call-1');
      await new Promise((r) => setTimeout(r, 120));
      expect(state.calls).toBe(1);
    });

    it('keeps the original when it wins after the hedge started', async () => {
      const { state, fetchImpl } = raceServer(40, 500);
      const client = new HttpClient({ fetchImpl, hedge: { afterMs: 10 } });
      await expect(client.text('https://api.test/x')).resolves.toBe('call-1');
      expect(state).toEqual({ calls: 2, aborted: 1 });
    });

    it('falls back to the other copy when one fails, and to retries when the first fails early', async () => {
      let calls = 0;
      const fetchImpl = async (): Promise<Response> => {
        calls += 1;
        const n = calls;
        if (n === 1) { await new Promise((r) => setTimeout(r, 30)); throw new TypeError('reset'); }
        await new Promise((r) => setTimeout(r, 40));
        return new Response(`call-${n}`);
      };
      const client = new HttpClient({ fetchImpl, retries: 0, hedge: { afterMs: 10 } });
      await expect(client.text('https://api.test/x')).resolves.toBe('call-2');

      let early = 0;
      const failingFast = async (): Promise<Response> => { early += 1; throw new TypeError('refused'); };
      const strict = new HttpClient({ fetchImpl: failingFast, retries: 0, hedge: { afterMs: 50 } });
      await expect(strict.text('https://api.test/x')).rejects.toThrow('refused');
      await new Promise((r) => setTimeout(r, 70));
      expect(early).toBe(1);
    });

    it('only hedges GET and HEAD', async () => {
      const { state, fetchImpl } = raceServer(80, 5);
      const client = new HttpClient({ fetchImpl, hedge: { afterMs: 10 } });
      await expect(client.text('https://api.test/x', { method: 'POST', body: 'x' })).resolves.toBe('call-1');
      expect(state.calls).toBe(1);
    });

    it('respects caller cancellation for both copies', async () => {
      const { state, fetchImpl } = raceServer(500, 500);
      const controller = new AbortController();
      const client = new HttpClient({ fetchImpl, hedge: { afterMs: 10 } });
      const pending = client.text('https://api.test/x', { signal: controller.signal });
      setTimeout(() => controller.abort(new Error('caller cancelled')), 40);
      await expect(pending).rejects.toThrow('caller cancelled');
      expect(state).toEqual({ calls: 2, aborted: 2 });
    });

    it('counts both copies against the in-flight limit', async () => {
      let active = 0;
      let maxActive = 0;
      const fetchImpl = async (): Promise<Response> => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 30));
        active -= 1;
        return new Response('ok');
      };
      const client = new HttpClient({ fetchImpl, concurrency: 2, hedge: { afterMs: 5 } });
      await Promise.all(Array.from({ length: 4 }, (_, i) => client.text(`https://api.test/${i}`)));
      expect(maxActive).toBeLessThanOrEqual(2);
    });
  });

  it('honours Retry-After on 429', async () => {
    let calls = 0;
    const started = Date.now();
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) return new Response('', { status: 429, headers: { 'retry-after': '0.02' } });
      return new Response('{"ok":true}', { status: 200 });
    };
    const client = new HttpClient({ retries: 1, fetchImpl });
    await expect(client.json('https://api.test/x')).resolves.toEqual({ ok: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
