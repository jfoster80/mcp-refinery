/**
 * Model Routing & Deliberation facade.
 */
export { getModelRegistry, getModel, getBestForTier, getArchitectPair, getModelSummary, getApiKey, getActiveProviders } from './models.js';
export { classifyTask } from './classifier.js';
export type { ClassifyInput } from './classifier.js';
export { routeTask, modelSwitchInstruction } from './router.js';
export type { RoutingDecision, ModelAssignment, ExecutionMode } from './router.js';
export {
  startDeliberation, submitDeliberationResponse, resolveDeliberation,
  getDeliberation,
} from './deliberation.js';
export type { StartDeliberationInput, DeliberationResult } from './deliberation.js';
