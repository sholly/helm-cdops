import { ComponentType, ReactNode } from 'react';
import Tooltip from '@material-ui/core/Tooltip';
import {
  StatusAborted,
  StatusError,
  StatusOK,
  StatusPending,
  StatusRunning,
  StatusWarning,
} from '@backstage/core-components';
import {
  ArgoHealthStatus,
  ArgoOperationPhase,
  ArgoSyncStatus,
} from '@cdops/plugin-tekton-trigger-common';

type Indicator = ComponentType<{ children?: ReactNode }>;

const syncIndicators: Record<ArgoSyncStatus, Indicator> = {
  Synced: StatusOK,
  OutOfSync: StatusWarning,
  Unknown: StatusAborted,
};

const healthIndicators: Record<ArgoHealthStatus, Indicator> = {
  Healthy: StatusOK,
  Progressing: StatusRunning,
  Degraded: StatusError,
  Suspended: StatusPending,
  Missing: StatusWarning,
  Unknown: StatusAborted,
};

const operationIndicators: Record<ArgoOperationPhase, Indicator> = {
  Running: StatusRunning,
  Succeeded: StatusOK,
  Failed: StatusError,
  Error: StatusError,
  Terminating: StatusPending,
};

const withTooltip = (element: ReactNode, tooltip?: string) =>
  tooltip ? (
    <Tooltip title={tooltip}>
      <span>{element}</span>
    </Tooltip>
  ) : (
    <>{element}</>
  );

/** ArgoCD's sync status, i.e. whether the cluster matches the target revision. */
export const ArgoSyncStatusIndicator = (props: {
  status: ArgoSyncStatus;
  revision?: string;
}) => {
  const Indicator = syncIndicators[props.status] ?? StatusWarning;
  return withTooltip(
    <Indicator>{props.status}</Indicator>,
    props.revision ? `Synced to ${props.revision}` : undefined,
  );
};

/** ArgoCD's health status, i.e. whether what is deployed is actually working. */
export const ArgoHealthStatusIndicator = (props: {
  status: ArgoHealthStatus;
  message?: string;
}) => {
  const Indicator = healthIndicators[props.status] ?? StatusWarning;
  return withTooltip(<Indicator>{props.status}</Indicator>, props.message);
};

/** The most recent ArgoCD sync operation, shown while a deploy lands. */
export const ArgoOperationIndicator = (props: {
  phase: ArgoOperationPhase;
  message?: string;
}) => {
  const Indicator = operationIndicators[props.phase] ?? StatusWarning;
  return withTooltip(
    <Indicator>{`Sync ${props.phase}`}</Indicator>,
    props.message,
  );
};
