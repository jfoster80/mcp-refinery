/**
 * Knowledge facade.
 */
export {
  getAllPatterns, getPatternsByCategory, getCriticalPatterns,
  buildBaselinePromptSection, buildCleanupChecklist, buildImplementationGuide,
  matchFindingsToBaselines,
} from './baselines.js';
export type { BaselinePattern } from './baselines.js';
