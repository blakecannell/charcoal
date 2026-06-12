import chalk from 'chalk';
import { TContext } from '../../lib/context';
import { TScopeSpec } from '../../lib/engine/scope_spec';
import { ExitFailedError, KilledError } from '../../lib/errors';
import { CommandFailedError } from '../../lib/git/runner';
import { getPRInfoForBranches } from './prepare_branches';
import { validateBranchesToSubmit } from './validate_branches';
import { submitPullRequest } from './submit_prs';
import {
  createPrBodyFooter,
  footerFooter,
  footerTitle,
} from '../create_pr_body_footer';
import { getRejectedBranchesFromPushError } from '../../lib/git/push_branch';
import { execFileAsync, runWithLimit } from '../../lib/utils/exec_async';

// Concurrent gh invocations are capped to stay clear of GitHub's
// secondary rate limits — same call volume as before, tighter spacing.
const MAX_CONCURRENT_GH_CALLS = 4;

// eslint-disable-next-line max-lines-per-function
export async function submitAction(
  args: {
    scope: TScopeSpec;
    editPRFieldsInline: boolean | undefined;
    draft: boolean;
    publish: boolean;
    dryRun: boolean;
    updateOnly: boolean;
    reviewers: string | undefined;
    confirm: boolean;
    forcePush: boolean;
    select: boolean;
    always: boolean;
    branch: string | undefined;
  },
  context: TContext
): Promise<void> {
  // Check CLI pre-condition to warn early
  if (args.draft && args.publish) {
    throw new ExitFailedError(
      `Can't use both --publish and --draft flags in one command`
    );
  }
  if (args.dryRun) {
    context.splog.info(
      chalk.yellow(
        `Running submit in 'dry-run' mode. No branches will be pushed and no PRs will be opened or updated.`
      )
    );
    context.splog.newline();
    args.editPRFieldsInline = false;
  }

  if (!context.interactive) {
    args.editPRFieldsInline = false;
    args.reviewers = undefined;

    context.splog.info(
      `Running in non-interactive mode. Inline prompts to fill PR fields will be skipped${
        !(args.draft || args.publish)
          ? ' and new PRs will be created in draft mode'
          : ''
      }.`
    );
    context.splog.newline();
  }

  const allBranchNames = context.engine
    .getRelativeStack(context.engine.currentBranchPrecondition, args.scope)
    .filter((branchName) => !context.engine.isTrunk(branchName));

  const branchNames = args.select
    ? await selectBranches(context, allBranchNames)
    : allBranchNames;

  context.splog.info(
    chalk.blueBright(
      `🥞 Validating that this Charcoal stack is ready to submit...`
    )
  );
  context.splog.newline();
  // The remote ref fetch and the PR info sync are the two big network
  // reads — start the former here so they run concurrently inside
  // validateBranchesToSubmit, after the user has already seen output.
  const populateRemoteShasPromise = context.engine.populateRemoteShas();
  await validateBranchesToSubmit(
    branchNames,
    context,
    populateRemoteShasPromise
  );

  context.splog.info(
    chalk.blueBright(
      '✏️  Preparing to submit PRs for the following branches...'
    )
  );
  const submissionInfos = await getPRInfoForBranches(
    {
      branchNames: branchNames,
      editPRFieldsInline: args.editPRFieldsInline && context.interactive,
      draft: args.draft,
      publish: args.publish,
      updateOnly: args.updateOnly,
      reviewers: args.reviewers,
      dryRun: args.dryRun,
      select: args.select,
      always: args.always,
    },
    context
  );

  if (
    await shouldAbort(
      { ...args, hasAnyPrs: submissionInfos.length > 0 },
      context
    )
  ) {
    return;
  }

  const branchesToPush = submissionInfos.map((info) => info.head);
  context.splog.info(
    chalk.blueBright(
      `📨 Pushing ${branchesToPush.length} ${
        branchesToPush.length === 1 ? 'branch' : 'branches'
      } to remote...`
    )
  );

  try {
    // One git invocation for the whole stack: one connection, one pack.
    context.engine.pushBranches(branchesToPush, args.forcePush);
  } catch (err) {
    if (
      err instanceof CommandFailedError &&
      err.message.includes('stale info')
    ) {
      const rejectedBranches = getRejectedBranchesFromPushError(err.message);
      const rejectedDescription = rejectedBranches.length
        ? rejectedBranches.map((b) => chalk.yellow(b)).join(', ')
        : chalk.yellow(branchesToPush.join(', '));
      throw new ExitFailedError(
        [
          `Force-with-lease push of ${rejectedDescription} failed due to external changes to the remote branch${
            rejectedBranches.length === 1 ? '' : 'es'
          }.`,
          ...(rejectedBranches.length > 0 &&
          rejectedBranches.length < branchesToPush.length
            ? ['All other branches in the submission were pushed.']
            : []),
          'If you are collaborating on this stack, try `gt downstack get` to pull in changes.',
          'Alternatively, use the `--force` option of this command to bypass the stale info warning.',
        ].join('\n')
      );
    }
    throw err;
  }

  context.splog.info(
    chalk.blueBright(
      `🔁 Creating/updating ${submissionInfos.length} PR${
        submissionInfos.length === 1 ? '' : 's'
      } on GitHub...`
    )
  );

  // Each branch's PR is independent once everything is pushed; run them
  // concurrently. Result lines print as each one settles.
  await runWithLimit(
    submissionInfos.map(
      (submissionInfo) => () => submitPullRequest([submissionInfo], context)
    ),
    MAX_CONCURRENT_GH_CALLS
  );

  context.splog.info(
    chalk.blueBright('\n🌳 Updating dependency trees in PR bodies...')
  );

  await runWithLimit(
    branchNames.map((branch) => async () => {
      const prInfo = context.engine.getPrInfo(branch);
      const footer = createPrBodyFooter(context, branch);

      if (!prInfo) {
        throw new Error(`PR info is undefined for branch ${branch}`);
      }

      const prFooterChanged = !prInfo.body?.includes(footer);

      if (prFooterChanged) {
        await execFileAsync('gh', [
          'pr',
          'edit',
          `${prInfo.number}`,
          '--body',
          updatePrBodyFooter(prInfo.body, footer),
        ]);
      }

      // Print for no-op branches too, so the final phase never looks hung.
      context.splog.info(
        `${chalk.green(branch)}: ${prInfo.url} (${
          prFooterChanged ? chalk.yellow('Updated') : 'No-op'
        })`
      );
    }),
    MAX_CONCURRENT_GH_CALLS
  );

  if (!context.interactive) {
    return;
  }
}

export function updatePrBodyFooter(
  body: string | undefined,
  footer: string
): string {
  if (!body) {
    return footer;
  }

  // Get the core title and footer text without extra whitespace
  const titleText = footerTitle.trim().replace(/^\s*\n+|\n+\s*$/g, '');
  const footerText = footerFooter.trim().replace(/^\s*\n+|\n+\s*$/g, '');

  const escapedTitleText = titleText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedFooterText = footerText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Match a pattern where there's the main body content, followed by the footer section
  // The footer section starts with the title text and ends with the footer text
  const matchExistingFooter = new RegExp(
    `(?<body>[\\s\\S]*)(?<footer>${escapedTitleText}[\\s\\S]*?${escapedFooterText})$`,
    's'
  );

  const match = matchExistingFooter.exec(body);

  if (match?.groups?.body) {
    return match.groups.body + footer;
  }

  return body + footer;
}

async function selectBranches(
  context: TContext,
  branchNames: string[]
): Promise<string[]> {
  const result = [];
  for (const branchName of branchNames) {
    const selected = (
      await context.prompts({
        name: 'value',
        initial: true,
        type: 'confirm',
        message: `Would you like to submit ${chalk.cyan(branchName)}?`,
      })
    ).value;
    // Clear the prompt result
    process.stdout.moveCursor(0, -1);
    process.stdout.clearLine(1);
    if (selected) {
      result.push(branchName);
    }
  }
  return result;
}

async function shouldAbort(
  args: { dryRun: boolean; confirm: boolean; hasAnyPrs: boolean },
  context: TContext
): Promise<boolean> {
  if (args.dryRun) {
    context.splog.info(chalk.blueBright('✅ Dry run complete.'));
    return true;
  }

  if (!args.hasAnyPrs) {
    context.splog.info(chalk.blueBright('🆗 All PRs up to date.'));
    return true;
  }

  if (
    context.interactive &&
    args.confirm &&
    !(
      await context.prompts({
        type: 'confirm',
        name: 'value',
        message: 'Continue with this submit operation?',
        initial: true,
      })
    ).value
  ) {
    context.splog.info(chalk.blueBright('🛑 Aborted submit.'));
    throw new KilledError();
  }

  return false;
}
