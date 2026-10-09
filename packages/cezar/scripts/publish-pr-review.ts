// Manual fallback only: the `pr-review` workflow's `github.review-comment` node publishes on its
// own. Publishes a SUCCESSFUL review run's final text as ONE PR comment, idempotent per PR +
// reviewed HEAD. Runs with the operator's own `gh` auth (the agent has none).
//
//   node --import tsx packages/cezar/scripts/publish-pr-review.ts \
//     --repo owner/name --pr 25 --head <sha> --body-file review.md [--dry-run]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { publishPrReviewComment } from '../src/automations/pr-review.ts';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    pr: { type: 'string' },
    head: { type: 'string' },
    'body-file': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const number = Number(values.pr);
if (!values.repo || !Number.isInteger(number) || !/^[0-9a-f]{40}$/.test(values.head ?? '') || !values['body-file']) {
  console.error('usage: --repo owner/name --pr <n> --head <40-hex sha> --body-file <file> [--dry-run]');
  process.exit(2);
}
const result = await publishPrReviewComment({
  repoRoot: process.cwd(),
  repo: values.repo,
  number,
  headSha: values.head!,
  body: readFileSync(values['body-file'], 'utf8'),
  dryRun: values['dry-run'],
});
console.log(result.status === 'dry-run' ? `dry-run — would post:\n${result.body}` : result.status);
