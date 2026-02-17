/**
 * Command facade.
 */
export {
  startPipeline, advancePipeline, getPipeline, getActivePipeline,
  getOverlayRequirements, cancelPipeline, purgeStuckPipelines,
} from './orchestrator.js';
export type { PipelineState, StepResult, CommandName, OverlayName } from './orchestrator.js';
