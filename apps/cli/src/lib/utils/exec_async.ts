import { execFile } from 'child_process';

export class ExecFailedError extends Error {
  public readonly stdout: string;
  public readonly stderr: string;
  constructor(failure: {
    command: string;
    args: string[];
    stdout: string;
    stderr: string;
    cause: Error;
  }) {
    super(
      [
        failure.cause.message,
        [failure.command].concat(failure.args).join(' '),
        failure.stdout,
        failure.stderr,
      ].join('\n')
    );
    this.name = 'ExecFailed';
    this.stdout = failure.stdout;
    this.stderr = failure.stderr;
  }
}

/**
 * Promise-based execFile for non-git subprocesses (primarily `gh`).
 * Unlike execFileSync, this does not block the event loop, so multiple
 * calls can genuinely run concurrently and progress output stays live.
 */
export function execFileAsync(
  command: string,
  args: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new ExecFailedError({
              command,
              args,
              stdout: stdout ?? '',
              stderr: stderr ?? '',
              cause: error,
            })
          );
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * Run a list of async tasks with at most `limit` in flight at once.
 * Results are returned in input order; the first rejection propagates
 * after in-flight tasks settle.
 */
export async function runWithLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = new Array(Math.min(limit, tasks.length))
    .fill(null)
    .map(async () => {
      while (next < tasks.length) {
        const current = next++;
        results[current] = await tasks[current]();
      }
    });
  await Promise.all(workers);
  return results;
}
