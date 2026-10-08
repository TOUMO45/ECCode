'use strict';
// Project configuration with safe defaults. Limits are deliberately
// conservative; every one of them is overridable in .eccode/config.json.

const path = require('path');
const { readJson, writeJson, EccodeError } = require('./util');

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  limits: {
    maxConcurrency: 2, // simultaneous claimed tasks
    maxReviewIterations: 3, // rejections per gate before escalation
    maxTaskRetries: 2, // failed attempts per task before escalation
    maxRuntimeMinutes: 480, // total recorded agent runtime
    maxCostUsd: 25, // total recorded agent spend
    staleRunMinutes: 60, // open runs older than this are treated as interrupted
  },
  review: {
    // Structural expectations for each gate's artifacts (Markdown headings).
    requiredSections: {
      architecture: ['Users', 'Problem', 'Requirements', 'Acceptance Criteria', 'Architecture', 'Assumptions', 'Open Questions', 'Risks'],
      design: ['Components', 'Interface Contracts', 'Data Design', 'Security', 'Testing Strategy', 'Deployment'],
    },
    minEvidencePerApproval: 1,
  },
  roles: {
    // Who may author and who may approve each gate kind. Reviewers can never
    // be the author of the artifact they approve (enforced separately).
    architecture: { authors: ['product-architect'], reviewers: ['architecture-reviewer'] },
    design: { authors: ['technical-designer'], reviewers: ['technical-reviewer'] },
    plan: { authors: ['delivery-lead'], reviewers: ['technical-reviewer'] },
    phase: {
      authors: ['delivery-lead', 'frontend-engineer', 'backend-engineer', 'ai-engineer', 'test-engineer', 'devops-engineer', 'learning-debugger'],
      reviewers: ['technical-reviewer', 'security-reviewer'],
    },
    verification: { authors: ['delivery-lead', 'test-engineer'], reviewers: ['technical-reviewer', 'security-reviewer'] },
  },
  pricing: {
    // Optional blended rate used to estimate cost when only token counts are
    // reported. null = record reported cost only (no estimate).
    usdPerMillionTokens: null,
  },
  memory: {
    learning: true, // false (or env ECCODE_LEARNING=off) disables lesson retrieval, recording and self-improvement
    staleAfterDays: 180,
    sharedDir: null, // defaults to ~/.eccode/memory (or ECCODE_SHARED_MEMORY)
    embedCommand: null, // optional external embedder: reads JSON {texts:[]} on stdin, prints {vectors:[[...]]}
    duplicateThreshold: 0.82,
  },
  improvement: {
    requireUserForAdoption: true,
    // Proposals may never touch these paths: permissions, approval rules, the
    // record, and the engine wherever it is installed (lib/, bin/, hooks,
    // schemas; .claude/eccode/** for a project-local install).
    protectedPaths: [
      '.eccode/config.json', '.claude/settings.json', '.claude/settings.local.json', 'hooks/hooks.json', 'lib/**',
      '.eccode/**', '**/eccode/**', 'bin/**', 'scripts/hooks/**', 'schemas/**', 'hooks/**',
    ],
  },
});

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function configPath(root) {
  return path.join(root, '.eccode', 'config.json');
}

function loadConfig(root) {
  const user = readJson(configPath(root), {});
  const cfg = deepMerge(DEFAULT_CONFIG, user);
  for (const [k, v] of Object.entries(cfg.limits)) {
    if (typeof v !== 'number' || !(v > 0)) {
      throw new EccodeError('INVALID_CONFIG', `limits.${k} must be a positive number (got ${JSON.stringify(v)})`);
    }
  }
  return cfg;
}

function writeDefaultConfig(root) {
  writeJson(configPath(root), DEFAULT_CONFIG);
}

/**
 * Paths self-improvement may never change. The defaults are a floor a
 * project's config can extend but not shrink: a config.json written by an
 * older version carries its own list, which would otherwise miss newer entries.
 */
function protectedPaths(config) {
  const extra = (config && config.improvement && config.improvement.protectedPaths) || [];
  return [...new Set([...DEFAULT_CONFIG.improvement.protectedPaths, ...extra])];
}

/**
 * Whether learning (lesson retrieval/recording, self-improvement) is on.
 * ECCODE_LEARNING=on|off overrides memory.learning; ambiguous values are refused.
 */
function learningEnabled(config) {
  const raw = process.env.ECCODE_LEARNING;
  if (raw !== undefined && raw !== '') {
    const v = raw.trim().toLowerCase();
    if (['off', '0', 'false', 'no'].includes(v)) return false;
    if (['on', '1', 'true', 'yes'].includes(v)) return true;
    throw new EccodeError('INVALID_CONFIG', `ECCODE_LEARNING must be on or off (got ${JSON.stringify(raw)})`);
  }
  return !(config && config.memory && config.memory.learning === false);
}

module.exports = { DEFAULT_CONFIG, loadConfig, writeDefaultConfig, configPath, deepMerge, learningEnabled, protectedPaths };
