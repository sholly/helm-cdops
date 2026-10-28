import { useState } from 'react';
import Box from '@material-ui/core/Box';
import IconButton from '@material-ui/core/IconButton';
import Tooltip from '@material-ui/core/Tooltip';
import Typography from '@material-ui/core/Typography';
import CancelIcon from '@material-ui/icons/Cancel';
import LaunchIcon from '@material-ui/icons/Launch';
import RefreshIcon from '@material-ui/icons/Refresh';
import {
  Link,
  ResponseErrorPanel,
  Table,
  TableColumn,
} from '@backstage/core-components';
import { alertApiRef, useApi } from '@backstage/core-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  isPipelineRunComplete,
  PipelineRunSummary,
  tektonPipelineCancelPermission,
} from '@cdops/plugin-tekton-trigger-common';
import { tektonTriggerApiRef } from '../../api';
import {
  formatDuration,
  formatRelativeTime,
  formatTimestamp,
} from '../../util';
import { PipelineRunStatusIndicator } from './PipelineRunStatusIndicator';

export interface PipelineRunsTableProps {
  entityRef: string;
  runs: PipelineRunSummary[];
  loading: boolean;
  error?: Error;
  onRefresh: () => void;
  /** Rows shown per page; the table is paginated for busy pipelines. */
  pageSize?: number;
}

export const PipelineRunsTable = (props: PipelineRunsTableProps) => {
  const { entityRef, runs, loading, error, onRefresh, pageSize = 5 } = props;
  const api = useApi(tektonTriggerApiRef);
  const alertApi = useApi(alertApiRef);
  const [cancelling, setCancelling] = useState<string | undefined>();

  const { allowed: canCancel } = usePermission({
    permission: tektonPipelineCancelPermission,
  });

  const cancel = async (run: PipelineRunSummary) => {
    setCancelling(run.name);
    try {
      await api.cancelPipelineRun(entityRef, run.name);
      alertApi.post({
        message: `Cancelling ${run.name}`,
        severity: 'info',
        display: 'transient',
      });
      onRefresh();
    } catch (cancelError) {
      alertApi.post({
        message: `Could not cancel ${run.name}: ${
          (cancelError as Error).message
        }`,
        severity: 'error',
      });
    } finally {
      setCancelling(undefined);
    }
  };

  if (error) {
    return <ResponseErrorPanel error={error} />;
  }

  const columns: TableColumn<PipelineRunSummary>[] = [
    {
      title: 'Run',
      field: 'name',
      render: run =>
        run.consoleUrl ? (
          <Link to={run.consoleUrl} target="_blank" rel="noopener noreferrer">
            {run.name}
          </Link>
        ) : (
          <>{run.name}</>
        ),
    },
    {
      title: 'Status',
      field: 'status',
      render: run => (
        <PipelineRunStatusIndicator
          status={run.status}
          reason={run.reason}
          message={run.message}
        />
      ),
    },
    {
      title: 'Started',
      field: 'startedAt',
      defaultSort: 'desc',
      render: run => (
        <Tooltip title={formatTimestamp(run.startedAt)}>
          <span>{formatRelativeTime(run.startedAt)}</span>
        </Tooltip>
      ),
    },
    {
      title: 'Duration',
      field: 'durationMs',
      render: run => <>{formatDuration(run.durationMs)}</>,
    },
    {
      title: 'Triggered by',
      field: 'triggeredBy',
      render: run => (
        <Typography variant="body2">{run.triggeredBy ?? 'cluster'}</Typography>
      ),
    },
    {
      title: '',
      sorting: false,
      width: '96px',
      render: run => (
        <Box display="flex" justifyContent="flex-end">
          {!isPipelineRunComplete(run.status) && (
            <Tooltip
              title={
                canCancel
                  ? 'Cancel this run'
                  : 'You do not have permission to cancel runs'
              }
            >
              <span>
                <IconButton
                  size="small"
                  disabled={!canCancel || cancelling === run.name}
                  onClick={() => cancel(run)}
                  aria-label={`Cancel ${run.name}`}
                >
                  <CancelIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
          {run.consoleUrl && (
            <Tooltip title="Open logs in the OpenShift console">
              <IconButton
                size="small"
                href={run.consoleUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${run.name} logs`}
              >
                <LaunchIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      ),
    },
  ];

  return (
    <Table<PipelineRunSummary>
      title="Pipeline runs"
      columns={columns}
      data={runs}
      isLoading={loading}
      options={{
        search: false,
        paging: runs.length > pageSize,
        pageSize,
        padding: 'dense',
        toolbar: true,
      }}
      actions={[
        {
          icon: () => <RefreshIcon />,
          tooltip: 'Refresh',
          isFreeAction: true,
          onClick: () => onRefresh(),
        },
      ]}
      emptyContent={
        <Box p={3} textAlign="center">
          <Typography variant="body2" color="textSecondary">
            No runs yet for this pipeline.
          </Typography>
        </Box>
      }
    />
  );
};
