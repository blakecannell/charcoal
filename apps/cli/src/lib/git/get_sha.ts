import {
  runAsyncGitCommand,
  runAsyncGitCommandAndSplitLines,
  runGitCommand,
} from './runner';

export function getShaOrThrow(ref: string): string {
  return runGitCommand({
    args: [`rev-parse`, ref],
    onError: 'throw',
    resource: 'getShaOrThrow',
  });
}

export function getSha(ref: string): string {
  return runGitCommand({
    args: [`rev-parse`, ref],
    onError: 'ignore',
    resource: 'getSha',
  });
}

export function getShaAsync(ref: string): Promise<string> {
  return runAsyncGitCommand({
    args: [`rev-parse`, ref],
    onError: 'ignore',
    resource: 'getSha',
  });
}

export function composeGetRemoteSha(): {
  populateRemoteShas: (remote: string) => Promise<void>;
  getRemoteSha: (branchName: string) => string | undefined;
} {
  let remoteShas: undefined | Record<string, string> = undefined;

  const populateRemoteShas = async (remote: string) => {
    remoteShas = await fetchRemoteShas(remote);
  };

  const getRemoteSha = (branchName: string) => remoteShas?.[branchName];
  return { populateRemoteShas, getRemoteSha };
}

// Note: we deliberately enumerate all heads rather than passing explicit
// refspecs — measured against a 55k-ref GitHub remote, the full
// advertisement (~5s) is ~3x faster than a prefix-filtered query.
// The win here is that the fetch is genuinely async, so it overlaps
// with the PR-info sync instead of blocking the event loop.
async function fetchRemoteShas(
  remote: string
): Promise<Record<string, string>> {
  const remoteShas: Record<string, string> = {};

  (
    await runAsyncGitCommandAndSplitLines({
      args: [`ls-remote`, '--heads', remote],
      onError: 'ignore',
      resource: 'fetchRemoteShas',
    })
  )
    // sample line of output
    // 7edb7094e4c66892d783c1effdd106df277a860e        refs/heads/main
    .map((line) => line.split(/\s+/))
    .filter(
      (lineSplit): lineSplit is [string, string] =>
        lineSplit.length === 2 &&
        lineSplit.every((s) => s.length > 0) &&
        lineSplit[1].startsWith('refs/heads/')
    )
    .forEach(
      ([sha, ref]) => (remoteShas[ref.slice('refs/heads/'.length)] = sha)
    );

  return remoteShas;
}
