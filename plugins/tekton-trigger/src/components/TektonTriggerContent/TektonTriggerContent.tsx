import { ReactNode } from 'react';
import Grid from '@material-ui/core/Grid';
import {
  InfoCard,
  Link,
  MissingAnnotationEmptyState,
  Progress,
  ResponseErrorPanel,
  StructuredMetadataTable,
} from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import {
  TEKTON_EVENT_LISTENER_ANNOTATION,
  TEKTON_NAMESPACE_ANNOTATION,
  TEKTON_PIPELINE_ANNOTATION,
} from '@cdops/plugin-tekton-trigger-common';
import { usePipelineRuns, useTektonTarget } from '../../hooks';
import { PipelineRunsTable } from '../PipelineRunsTable';
import { TriggerPipelineButton } from '../TriggerPipelineDialog';

/**
 * Entity tab: pipeline details, a trigger button and the run history.
 *
 * @public
 */
export const TektonTriggerContent = () => {
  const { entity } = useEntity();
  const entityRef = stringifyEntityRef(entity);

  const { target, loading, error } = useTektonTarget(entityRef);
  const runsEnabled = Boolean(target && !target.unconfiguredReason);
  const {
    runs,
    loading: runsLoading,
    error: runsError,
    refresh,
  } = usePipelineRuns(entityRef, runsEnabled);

  if (loading) {
    return <Progress />;
  }

  if (error) {
    return <ResponseErrorPanel title="Could not load pipeline" error={error} />;
  }

  if (!target || target.unconfiguredReason) {
    return (
      <MissingAnnotationEmptyState
        annotation={[
          TEKTON_PIPELINE_ANNOTATION,
          TEKTON_NAMESPACE_ANNOTATION,
          TEKTON_EVENT_LISTENER_ANNOTATION,
        ]}
      />
    );
  }

  const metadata: Record<string, ReactNode> = {
    mode:
      target.mode === 'eventListener'
        ? 'Tekton Triggers EventListener'
        : 'Direct PipelineRun',
    ...(target.pipeline
      ? {
          pipeline: target.consoleUrl ? (
            <Link
              to={target.consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {target.pipeline}
            </Link>
          ) : (
            target.pipeline
          ),
        }
      : {}),
    ...(target.eventListener ? { eventListener: target.eventListener } : {}),
    ...(target.cluster ? { cluster: target.cluster } : {}),
    ...(target.namespace ? { namespace: target.namespace } : {}),
    ...(target.params.length
      ? { parameters: target.params.map(param => param.name).join(', ') }
      : {}),
    ...(target.workspaces.length
      ? { workspaces: target.workspaces.map(ws => ws.name).join(', ') }
      : {}),
  };

  return (
    <Grid container spacing={3}>
      <Grid item xs={12} md={4}>
        <InfoCard
          title="OpenShift Pipeline"
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
          <StructuredMetadataTable metadata={metadata} />
        </InfoCard>
      </Grid>

      <Grid item xs={12} md={8}>
        <PipelineRunsTable
          entityRef={entityRef}
          runs={runs ?? []}
          loading={runsLoading}
          error={runsError}
          onRefresh={refresh}
          pageSize={10}
        />
      </Grid>
    </Grid>
  );
};
