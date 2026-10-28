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
import { PipelineRunStatus } from '@cdops/plugin-tekton-trigger-common';

const indicators: Record<
  PipelineRunStatus,
  ComponentType<{ children?: ReactNode }>
> = {
  Succeeded: StatusOK,
  Failed: StatusError,
  Running: StatusRunning,
  Pending: StatusPending,
  Cancelled: StatusAborted,
  Unknown: StatusWarning,
};

export const PipelineRunStatusIndicator = (props: {
  status: PipelineRunStatus;
  reason?: string;
  message?: string;
}) => {
  const { status, reason, message } = props;
  const Indicator = indicators[status] ?? StatusWarning;
  const element = <Indicator>{status}</Indicator>;

  const tooltip = [reason, message].filter(Boolean).join(': ');
  return tooltip ? (
    <Tooltip title={tooltip}>
      <span>{element}</span>
    </Tooltip>
  ) : (
    element
  );
};
