/**
 * A Backstage / Red Hat Developer Hub plugin that shows the deployed state of
 * a catalog entity's ArgoCD application and deploys a picked git version by
 * triggering an OpenShift Pipeline (Tekton).
 *
 * @packageDocumentation
 */
export {
  tektonTriggerPlugin,
  EntityArgoCdDeployCard,
  isArgoCdDeployAvailable,
  isTektonTriggerAvailable,
} from './plugin';
export { tektonTriggerApiRef, TektonTriggerClient } from './api';
export type { TektonTriggerApi } from './api';
export {
  ArgoCdDeployCard,
  DeployControls,
  DeployedState,
  RecentPipelineRuns,
} from './components/ArgoCdDeployCard';
export { PipelineRunStatusIndicator } from './components/PipelineRunStatusIndicator';
export {
  useArgoApplication,
  useGitVersions,
  usePipelineRuns,
  useTektonTarget,
} from './hooks';
