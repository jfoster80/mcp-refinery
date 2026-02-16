/**
 * Knowledge facade.
 */
export {
  getAllPatterns, getPatternsByCategory, getCriticalPatterns,
  buildBaselinePromptSection, buildCleanupChecklist, matchFindingsToBaselines,
} from './baselines.js';
export type { BaselinePattern } from './baselines.js';
