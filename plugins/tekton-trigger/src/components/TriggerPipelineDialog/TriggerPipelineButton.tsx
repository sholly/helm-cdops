import { useState } from 'react';
import Button from '@material-ui/core/Button';
import Tooltip from '@material-ui/core/Tooltip';
import PlayArrowIcon from '@material-ui/icons/PlayArrow';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  TektonTarget,
  tektonPipelineTriggerPermission,
  TriggerPipelineResponse,
} from '@cdops/plugin-tekton-trigger-common';
import { TriggerPipelineDialog } from './TriggerPipelineDialog';

export interface TriggerPipelineButtonProps {
  entityRef: string;
  target: TektonTarget;
  onTriggered?: (response: TriggerPipelineResponse) => void;
  size?: 'small' | 'medium' | 'large';
  variant?: 'text' | 'outlined' | 'contained';
}

function describeAction(options: {
  target: TektonTarget;
  allowed: boolean;
  loading: boolean;
}): string {
  const { target, allowed, loading } = options;

  if (target.unconfiguredReason) {
    return target.unconfiguredReason;
  }
  if (!allowed && !loading) {
    return 'You do not have permission to trigger this pipeline';
  }
  if (target.mode === 'eventListener') {
    return `Send an event to ${target.eventListener}`;
  }
  return `Create a PipelineRun from ${target.pipeline}`;
}

/**
 * The button plus its dialog, so both the entity tab and the overview card
 * behave identically.
 */
export const TriggerPipelineButton = (props: TriggerPipelineButtonProps) => {
  const {
    entityRef,
    target,
    onTriggered,
    size = 'small',
    variant = 'contained',
  } = props;
  const [open, setOpen] = useState(false);

  const { allowed, loading } = usePermission({
    permission: tektonPipelineTriggerPermission,
  });

  const unavailable = target.unconfiguredReason;
  const disabled = loading || !allowed || Boolean(unavailable);
  const tooltip = describeAction({ target, allowed, loading });

  return (
    <>
      <Tooltip title={tooltip}>
        <span>
          <Button
            color="primary"
            variant={variant}
            size={size}
            disabled={disabled}
            startIcon={<PlayArrowIcon />}
            onClick={() => setOpen(true)}
          >
            Run pipeline
          </Button>
        </span>
      </Tooltip>

      {open && (
        <TriggerPipelineDialog
          open={open}
          entityRef={entityRef}
          target={target}
          onClose={() => setOpen(false)}
          onTriggered={onTriggered}
        />
      )}
    </>
  );
};
