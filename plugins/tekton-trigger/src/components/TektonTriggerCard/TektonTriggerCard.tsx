import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import {
  InfoCard,
  Link,
  Progress,
  ResponseErrorPanel,
} from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { usePipelineRuns, useTektonTarget } from '../../hooks';
import { PipelineRunStatusIndicator } from '../PipelineRunsTable';
import { TriggerPipelineButton } from '../TriggerPipelineDialog';
import { formatDuration, formatRelativeTime } from '../../util';

/**
 * Compact overview-tab card: the latest run plus a trigger button.
 *
 * Renders nothing when the entity has no Tekton annotations, so it can be added
 * to a shared entity page without `isTektonTriggerAvailable` guarding it.
 *
 * @public
 */
export const TektonTriggerCard = () => {
  const { entity } = useEntity();
  const entityRef = stringifyEntityRef(entity);

  const { target, loading, error } = useTektonTarget(entityRef);
  const runsEnabled = Boolean(target && !target.unconfiguredReason);
  const {
    runs,
    error: runsError,
    refresh,
  } = usePipelineRuns(entityRef, runsEnabled);

  if (loading) {
    return (
      <InfoCard title="OpenShift Pipeline">
        <Progress />
      </InfoCard>
    );
  }

  if (error) {
    return (
      <InfoCard title="OpenShift Pipeline">
        <ResponseErrorPanel error={error} />
      </InfoCard>
    );
  }

  if (!target || target.unconfiguredReason) {
    return null;
  }

  const latest = runs?.[0];

  // A function rather than chained ternaries, so each case stays readable.
  const renderLatestRun = () => {
    if (runsError) {
      return (
        <Typography variant="body2" color="error">
          Could not load runs: {runsError.message}
        </Typography>
      );
    }

    if (!latest) {
      return (
        <Typography variant="body2" color="textSecondary">
          No runs yet.
        </Typography>
      );
    }

    return (
      <Box display="flex" flexDirection="column" gridGap={4}>
        <Box display="flex" alignItems="center">
          <PipelineRunStatusIndicator
            status={latest.status}
            reason={latest.reason}
            message={latest.message}
          />
        </Box>
        <Typography variant="body2" color="textSecondary">
          {latest.consoleUrl ? (
            <Link
              to={latest.consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {latest.name}
            </Link>
          ) : (
            latest.name
          )}{' '}
          · started {formatRelativeTime(latest.startedAt)} ·{' '}
          {formatDuration(latest.durationMs)}
        </Typography>
        {latest.triggeredBy && (
          <Typography variant="caption" color="textSecondary">
            Triggered by {latest.triggeredBy}
          </Typography>
        )}
      </Box>
    );
  };

  return (
    <InfoCard
      title="OpenShift Pipeline"
      subheader={
        target.mode === 'eventListener'
          ? target.eventListener
          : `${target.pipeline} · ${target.namespace}`
      }
      action={
        <div style={{ padding: 8 }}>
          <TriggerPipelineButton
            entityRef={entityRef}
            target={target}
            onTriggered={refresh}
          />
        </div>
      }
    >
      {renderLatestRun()}
    </InfoCard>
  );
};
