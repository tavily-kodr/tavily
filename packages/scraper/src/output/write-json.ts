import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * File output for scrape results. Deliberately separate from `UniversalScraper`,
 * which only fetches and extracts: callers decide what to save and where.
 */

export interface WriteJsonOptions {
  /** Replace an existing file. Default false: an existing file is an error, never silently replaced. */
  overwrite?: boolean;
  /** `JSON.stringify` indentation (default 2). Use 0 for compact output. */
  indent?: number;
}

export interface WriteJsonResult {
  /** Absolute path that was written. */
  path: string;
  /** Size of the written file in bytes. */
  bytes: number;
}

export type OutputErrorReason = 'exists' | 'serialize' | 'filesystem';

/** Thrown when output cannot be written. `code` is the Node errno code (EACCES, EISDIR, …) when there is one. */
export class OutputWriteError extends Error {
  readonly path: string;
  readonly reason: OutputErrorReason;
  readonly code: string | undefined;

  constructor(message: string, path: string, reason: OutputErrorReason, options: { code?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'OutputWriteError';
    this.path = path;
    this.reason = reason;
    this.code = options.code;
  }
}

/**
 * Serialises `data` as JSON (UTF-8, trailing newline) and writes it to
 * `outputPath`, creating missing parent directories.
 *
 * - Without `overwrite`, the file is created exclusively (`wx`), so an existing
 *   file, even one created concurrently, raises `OutputWriteError` with
 *   reason `exists` and is left untouched.
 * - With `overwrite`, the JSON goes to a temporary sibling file that is then
 *   renamed over the target, so readers never see a half-written file.
 * - Data is serialised before the filesystem is touched: values JSON cannot
 *   represent (circular references, BigInt) fail with reason `serialize` and
 *   create nothing. Like `JSON.stringify`, `undefined` and functions in
 *   objects are dropped and `Date` becomes an ISO string.
 */
export async function writeJsonOutput(outputPath: string, data: unknown, options: WriteJsonOptions = {}): Promise<WriteJsonResult> {
  if (outputPath.trim() === '') throw new OutputWriteError('Output path is empty', outputPath, 'filesystem');
  const path = resolve(outputPath);

  let text: string | undefined;
  try {
    text = JSON.stringify(data, null, options.indent ?? 2);
  } catch (error) {
    throw new OutputWriteError(`Cannot serialise output as JSON: ${messageOf(error)}`, path, 'serialize', { cause: error });
  }
  // JSON.stringify returns undefined for a bare undefined / function / symbol.
  if (text === undefined) throw new OutputWriteError('Cannot serialise output as JSON: value has no JSON representation', path, 'serialize');
  const body = `${text}\n`;

  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (error) {
    throw fsError(error, dirname(path), 'create output directory');
  }

  if (options.overwrite) {
    const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await writeFile(temp, body, { encoding: 'utf8', flag: 'wx' });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw fsError(error, path, 'write');
    }
  } else {
    let file: FileHandle;
    try {
      file = await open(path, 'wx');
    } catch (error) {
      if (codeOf(error) === 'EEXIST') throw (await existingPathError(path)) ?? fsError(error, path, 'write');
      throw fsError(error, path, 'write');
    }
    try {
      await file.writeFile(body, 'utf8');
      await file.close();
    } catch (error) {
      // This call created the file, so removing it cannot lose anyone's data;
      // it avoids leaving a truncated file behind (e.g. ENOSPC mid-write).
      await file.close().catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
      throw fsError(error, path, 'write');
    }
  }

  return { path, bytes: Buffer.byteLength(body) };
}

/**
 * Fails early, before any scraping, when `outputPath` is already known to be
 * refused: it is a directory, or it is an existing file and `overwrite` is
 * off. `writeJsonOutput` still re-checks atomically, so this is only a fast
 * path; permission and disk errors are reported by the write itself.
 */
export async function assertOutputWritable(outputPath: string, options: Pick<WriteJsonOptions, 'overwrite'> = {}): Promise<void> {
  const path = resolve(outputPath);
  const error = await existingPathError(path);
  if (error && !(options.overwrite && error.reason === 'exists')) throw error;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const codeOf = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const HINTS: Record<string, string> = {
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EISDIR: 'path is a directory',
  ENOTDIR: 'a parent path is a file, not a directory',
  ENOSPC: 'no space left on device',
  EROFS: 'read-only file system',
  ENAMETOOLONG: 'path is too long',
};

/** Why an existing `path` cannot be written without overwrite; undefined when nothing is there. */
async function existingPathError(path: string): Promise<OutputWriteError | undefined> {
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(path)).isDirectory();
  } catch {
    return undefined;
  }
  return isDirectory
    ? new OutputWriteError(`Cannot write ${path}: path is a directory`, path, 'filesystem', { code: 'EISDIR' })
    : new OutputWriteError(`Output file already exists: ${path} (pass overwrite to replace it)`, path, 'exists', { code: 'EEXIST' });
}

function fsError(error: unknown, path: string, action: string): OutputWriteError {
  const code = codeOf(error);
  const hint = code ? HINTS[code] ?? code : messageOf(error);
  return new OutputWriteError(`Cannot ${action} ${path}: ${hint}`, path, 'filesystem', { code, cause: error });
}
