import { API_ROUTES } from '@withgraphite/graphite-cli-routes';

import t from '@withgraphite/retype';
import {
  ExecFailedError,
  execFileAsync,
  runWithLimit,
} from '../utils/exec_async';

type TBranchNameWithPrNumber = {
  branchName: string;
  prNumber: number | undefined;
};

export type TPRInfoToUpsert = t.UnwrapSchemaMap<
  typeof API_ROUTES.pullRequestInfo.response
>['prs'];

type TRawPr = {
  state: string;
  url: string;
  title: string;
  body: string;
  number: number;
  headRefName: string;
  baseRefName: string;
  reviewDecision: string | null;
  isDraft: boolean;
};

// GitHub resolves up to ~100 aliased nodes per GraphQL request; stay
// comfortably under that and run at most two requests in flight.
const MAX_NODES_PER_QUERY = 50;
const MAX_CONCURRENT_QUERIES = 2;

export async function getPrInfoForBranches(
  branchNamesWithExistingPrInfo: TBranchNameWithPrNumber[],
  opts?: { warn?: (message: string) => void }
): Promise<TPRInfoToUpsert> {
  // We sync branches without existing PR info by name.  For branches
  // that are already associated with a PR, we only sync if both the
  // the associated PR (keyed by number) if the name matches the headRef.

  const branchesWithoutPrInfo = new Set<string>();
  const existingPrInfo = new Map<number, string>();

  branchNamesWithExistingPrInfo.forEach((branch) => {
    if (branch?.prNumber === undefined) {
      branchesWithoutPrInfo.add(branch.branchName);
    } else {
      existingPrInfo.set(branch.prNumber, branch.branchName);
    }
  });

  try {
    // One batched GraphQL request (chunked) replaces N sequential
    // `gh pr view` round-trips.
    const rawPrs = await fetchPrsBatched(
      [...existingPrInfo.keys()],
      [...branchesWithoutPrInfo]
    );

    const response: TPRInfoToUpsert = rawPrs.map((pr) => ({
      prNumber: pr.number,
      state: pr.state,
      url: pr.url,
      title: pr.title,
      body: pr.body,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      reviewDecision:
        pr.reviewDecision === null || pr.reviewDecision === ''
          ? undefined
          : pr.reviewDecision,
      isDraft: pr.isDraft,
    })) as TPRInfoToUpsert;

    return response.filter((pr) => {
      const branchNameIfAssociated = existingPrInfo.get(pr.prNumber);

      const shouldAssociatePrWithBranch =
        !branchNameIfAssociated &&
        pr.state === 'OPEN' &&
        branchesWithoutPrInfo.has(pr.headRefName);

      const shouldUpdateExistingBranch =
        branchNameIfAssociated === pr.headRefName;

      return shouldAssociatePrWithBranch || shouldUpdateExistingBranch;
    });
  } catch (error) {
    // The legacy Graphite API behavior was to return an empty array on
    // failure; we keep that contract but no longer fail silently.
    opts?.warn?.(
      `Could not fetch PR info from GitHub${
        error instanceof Error ? `: ${error.message.split('\n')[0]}` : ''
      }`
    );
    return [];
  }
}

const PR_FIELDS_FRAGMENT = `
fragment PrFields on PullRequest {
  state
  url
  title
  body
  number
  headRefName
  baseRefName
  reviewDecision
  isDraft
}`;

async function fetchPrsBatched(
  prNumbers: number[],
  branchNames: string[]
): Promise<TRawPr[]> {
  type TQueryNode =
    | { kind: 'number'; prNumber: number }
    | { kind: 'branch'; branchName: string };

  const nodes: TQueryNode[] = [
    ...prNumbers.map((prNumber) => ({ kind: 'number' as const, prNumber })),
    ...branchNames.map((branchName) => ({
      kind: 'branch' as const,
      branchName,
    })),
  ];

  if (nodes.length === 0) {
    return [];
  }

  const chunks: TQueryNode[][] = [];
  for (let i = 0; i < nodes.length; i += MAX_NODES_PER_QUERY) {
    chunks.push(nodes.slice(i, i + MAX_NODES_PER_QUERY));
  }

  const results = await runWithLimit(
    chunks.map((chunk) => () => fetchPrChunk(chunk)),
    MAX_CONCURRENT_QUERIES
  );

  return results.flat();
}

async function fetchPrChunk(
  nodes: Array<
    | { kind: 'number'; prNumber: number }
    | { kind: 'branch'; branchName: string }
  >
): Promise<TRawPr[]> {
  const selections = nodes
    .map((node, i) =>
      node.kind === 'number'
        ? `n${i}: pullRequest(number: ${node.prNumber}) { ...PrFields }`
        : `n${i}: ref(qualifiedName: ${JSON.stringify(
            `refs/heads/${node.branchName}`
          )}) { associatedPullRequests(first: 10, states: OPEN) { nodes { ...PrFields } } }`
    )
    .join('\n');

  const query = `${PR_FIELDS_FRAGMENT}
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${selections}
  }
}`;

  const stdout = await runGraphqlAllowingPartialErrors(query);
  const repository = JSON.parse(stdout)?.data?.repository;
  if (!repository) {
    return [];
  }

  const prs: TRawPr[] = [];
  nodes.forEach((node, i) => {
    const aliasedNode = repository[`n${i}`];
    if (!aliasedNode) {
      // Deleted PR number or branch with no remote ref — skip.
      return;
    }
    if (node.kind === 'number') {
      prs.push(aliasedNode as TRawPr);
    } else {
      const associated = aliasedNode.associatedPullRequests?.nodes ?? [];
      // Mirror `gh pr view <branch>`: take the first open PR whose head
      // actually is this branch (associatedPullRequests can include PRs
      // from forks with the same branch name).
      const match = (associated as TRawPr[]).find(
        (pr) => pr.headRefName === node.branchName
      );
      if (match) {
        prs.push(match);
      }
    }
  });
  return prs;
}

// `gh api graphql` exits non-zero when the response contains any GraphQL
// error (e.g. one stale PR number in an otherwise-fine batch), but still
// prints the partial data. Salvage it.
async function runGraphqlAllowingPartialErrors(
  query: string
): Promise<string> {
  try {
    return await execFileAsync('gh', [
      'api',
      'graphql',
      '-F',
      'owner={owner}',
      '-F',
      'name={repo}',
      '-f',
      `query=${query}`,
    ]);
  } catch (error) {
    if (error instanceof ExecFailedError && error.stdout) {
      try {
        if (JSON.parse(error.stdout)?.data?.repository) {
          return error.stdout;
        }
      } catch {
        // fall through to rethrow
      }
    }
    throw error;
  }
}
