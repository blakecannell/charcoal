import { expect } from 'chai';
import { getRejectedBranchesFromPushError } from '../../src/lib/git/push_branch';
import { runWithLimit } from '../../src/lib/utils/exec_async';

describe('getRejectedBranchesFromPushError', function () {
  it('extracts each rejected ref from a partial push failure', () => {
    const stderr = [
      'To github.com:owner/repo.git',
      '   1111111..2222222  feat-api -> feat-api',
      ' ! [rejected]        feat-ui -> feat-ui (stale info)',
      ' ! [rejected]        feat-polish -> feat-polish (stale info)',
      "error: failed to push some refs to 'github.com:owner/repo.git'",
    ].join('\n');

    expect(getRejectedBranchesFromPushError(stderr)).to.deep.equal([
      'feat-ui',
      'feat-polish',
    ]);
  });

  it('returns an empty list when nothing was rejected', () => {
    expect(
      getRejectedBranchesFromPushError('Everything up-to-date')
    ).to.deep.equal([]);
  });
});

describe('runWithLimit', function () {
  it('returns results in input order', async () => {
    const results = await runWithLimit(
      [10, 5, 1].map((delay, i) => async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return i;
      }),
      2
    );
    expect(results).to.deep.equal([0, 1, 2]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runWithLimit(
      new Array(10).fill(null).map(() => async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
      }),
      3
    );
    expect(maxInFlight).to.be.lessThanOrEqual(3);
  });
});
