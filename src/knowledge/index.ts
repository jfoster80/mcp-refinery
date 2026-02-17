/**
 * Knowledge facade.
 */
export {
  getAllPatterns, getPatternsByCategory, getCriticalPatterns,
  getCompliancePatterns, getCompliancePatternsBySeverity,
  buildBaselinePromptSection, buildCompliancePromptSection,
  buildCleanupChecklist, buildCleanupGuide,
  buildDocumentationGuide, buildImplementationGuide, matchFindingsToBaselines,
  buildFeedbackPromptSection,
} from './baselines.js';
export type { BaselinePattern, BaselineCategory } from './baselines.js';
