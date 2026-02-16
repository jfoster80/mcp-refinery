/**
 * Research Plane facade.
 */
export { startResearch, storeFindings } from './ingestion.js';
export { computeConsensus } from './consensus.js';
export { buildResearchPrompt, validateFindings, FINDINGS_JSON_SHAPE } from './providers/base.js';
export type { ResearchQuery } from './providers/base.js';
export { sanitizeFindings } from './normalizer.js';
