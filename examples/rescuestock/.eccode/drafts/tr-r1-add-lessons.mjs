// technical-reviewer helper: adds the `lessons` criterion to .eccode/reviews/drafts/rework-1-1.json (the engine asks
// for a judgement of the rework's not-applicable decision on mem-sd-mv1audrd-013b7102).
import { readFileSync, writeFileSync } from 'node:fs';
const file = '.eccode/reviews/drafts/rework-1-1.json';
const review = JSON.parse(readFileSync(file, 'utf8'));
if (!review.criteria.some((c) => c.id === 'lessons')) {
  review.criteria.push({
    id: 'lessons',
    description: "The rework's not-applicable decision on mem-sd-mv1audrd-013b7102 holds",
    met: true,
    evidence: ['ev:ev-mv2zz740-0184be8e', 'ev:ev-mv2zv70k-01ca6173', 'artifact:.eccode/artifacts/rework-1/submission.md#lessons'],
    notes: "The lesson applies to hooks or guards that map file writes to a project record or root. The rework changes only application code: config, the access hook's rate limit, throttle keys and the confirm service. Its 14 changed files are all inside its ownership, and none is a hook, a guard or root discovery (ev:ev-mv2zv70k-01ca6173). The installed guard is the repaired per-target-root version (sha256 d43f4b54...).",
  });
}
writeFileSync(file, JSON.stringify(review, null, 2) + '\n');
console.log('criteria: ' + review.criteria.map((c) => c.id).join(', '));
