/**
 * Knowledge facade.
 */
export {
  getAllPatterns, getPatternsByCategory, getCriticalPatterns,
  buildBaselinePromptSection, buildCleanupChecklist, buildDocumentationGuide,
  buildImplementationGuide, matchFindingsToBaselines,
} from './baselines.js';
export type { BaselinePattern } from './baselines.js';
