/**
 * Command facade.
 */
export {
  startPipeline, advancePipeline, getPipeline, getActivePipeline,
} from './orchestrator.js';
export type { PipelineState, StepResult, CommandName, OverlayName } from './orchestrator.js';
