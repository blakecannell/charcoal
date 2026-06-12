import { runGitCommand } from './runner';

export function pushBranches(opts: {
  remote: string;
  branchNames: string[];
  noVerify: boolean;
  forcePush: boolean;
}): void {
  if (opts.branchNames.length === 0) {
    return;
  }
  const forceOption = opts.forcePush ? '--force' : '--force-with-lease';

  // One push with all refspecs: a single connection and a single pack
  // negotiation for the whole stack. Bare --force-with-lease still
  // protects every listed ref individually.
  runGitCommand({
    args: [
      `push`,
      `-u`,
      opts.remote,
      forceOption,
      ...opts.branchNames,
      ...(opts.noVerify ? ['--no-verify'] : []),
    ],
    options: { stdio: 'pipe' },
    onError: 'throw',
    resource: 'pushBranches',
  });
}

// On partial rejection git lists each failed ref, e.g.:
//  ! [rejected]        my-branch -> my-branch (stale info)
export function getRejectedBranchesFromPushError(
  errorMessage: string
): string[] {
  return [...errorMessage.matchAll(/!\s+\[rejected\]\s+(\S+)\s+->/g)].map(
    (match) => match[1]
  );
}
