/**
 * Command facade.
 */
export {
  startPipeline, advancePipeline, getPipeline, getActivePipeline,
  getOverlayRequirements,
} from './orchestrator.js';
export type { PipelineState, StepResult, CommandName, OverlayName } from './orchestrator.js';
