import { useEffect, useMemo, useState } from 'react';
import Box from '@material-ui/core/Box';
import Divider from '@material-ui/core/Divider';
import FormControl from '@material-ui/core/FormControl';
import IconButton from '@material-ui/core/IconButton';
import InputLabel from '@material-ui/core/InputLabel';
import MenuItem from '@material-ui/core/MenuItem';
import Select from '@material-ui/core/Select';
import Tooltip from '@material-ui/core/Tooltip';
import Typography from '@material-ui/core/Typography';
import LaunchIcon from '@material-ui/icons/Launch';
import RefreshIcon from '@material-ui/icons/Refresh';
import { makeStyles } from '@material-ui/core/styles';
import {
  InfoCard,
  Link,
  Progress,
  ResponseErrorPanel,
} from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import {
  useArgoApplication,
  useGitVersions,
  usePipelineRuns,
} from '../../hooks';
import { DeployControls } from './DeployControls';
import { DeployedState } from './DeployedState';
import { RecentPipelineRuns } from './RecentPipelineRuns';

const TITLE = 'ArgoCD Deployment';

const useStyles = makeStyles(theme => ({
  appSelect: {
    minWidth: 200,
    marginBottom: theme.spacing(1),
  },
  divider: {
    marginTop: theme.spacing(2),
  },
}));

/**
 * The entity's ArgoCD deployment: what is deployed now, which git version to
 * deploy next, and the button that runs the pipeline to get there.
 *
 * Renders nothing when the entity has no ArgoCD annotations, so it can be
 * added to a shared entity page without `isArgoCdDeployAvailable` guarding it.
 *
 * @public
 */
export const ArgoCdDeployCard = () => {
  const { entity } = useEntity();
  const entityRef = stringifyEntityRef(entity);
  const classes = useStyles();

  const { state, loading, error, refresh } = useArgoApplication(entityRef);
  const [selectedApp, setSelectedApp] = useState<string | undefined>();

  // Memoised so the effect below keys off the polled result, not every render.
  const apps = useMemo(() => state?.apps ?? [], [state]);

  // Keep the picked application valid as the polled state comes and goes.
  useEffect(() => {
    setSelectedApp(current =>
      current && apps.some(app => app.name === current)
        ? current
        : apps[0]?.name,
    );
  }, [apps]);

  const app = apps.find(candidate => candidate.name === selectedApp);

  const {
    versions,
    loading: versionsLoading,
    error: versionsError,
  } = useGitVersions(entityRef, app?.name, Boolean(app));

  const {
    runs,
    error: runsError,
    refresh: refreshRuns,
  } = usePipelineRuns(entityRef, Boolean(app));

  if (loading) {
    return (
      <InfoCard title={TITLE}>
        <Progress />
      </InfoCard>
    );
  }

  if (error) {
    return (
      <InfoCard
        title={TITLE}
        action={
          <Box pr={1}>
            <Tooltip title="Retry">
              <IconButton onClick={refresh} aria-label="Retry">
                <RefreshIcon />
              </IconButton>
            </Tooltip>
          </Box>
        }
      >
        <ResponseErrorPanel error={error} />
      </InfoCard>
    );
  }

  // Nothing to say about an entity that is not wired up to ArgoCD at all.
  if (state?.unconfiguredReason && !apps.length) {
    return null;
  }

  if (!app) {
    return null;
  }

  const refreshAll = () => {
    refresh();
    refreshRuns();
  };

  return (
    <InfoCard
      title={TITLE}
      subheader={app.project ? `${app.name} · ${app.project}` : app.name}
      action={
        <Box display="flex" alignItems="center" pr={1}>
          <Tooltip title="Refresh">
            <IconButton onClick={refreshAll} aria-label="Refresh">
              <RefreshIcon />
            </IconButton>
          </Tooltip>
          {app.argoUrl && (
            <Tooltip title="Open in ArgoCD">
              <IconButton
                component={Link}
                to={app.argoUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open in ArgoCD"
              >
                <LaunchIcon />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      }
    >
      {apps.length > 1 && (
        <FormControl className={classes.appSelect} size="small">
          <InputLabel id="argocd-app-label">Application</InputLabel>
          <Select
            labelId="argocd-app-label"
            value={selectedApp ?? ''}
            onChange={event => setSelectedApp(event.target.value as string)}
          >
            {apps.map(candidate => (
              <MenuItem key={candidate.name} value={candidate.name}>
                {candidate.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}

      <DeployedState app={app} />

      <DeployControls
        entityRef={entityRef}
        app={app}
        versions={versions?.items ?? []}
        versionsLoading={versionsLoading}
        unavailableReason={
          versionsError?.message ?? versions?.unavailableReason
        }
        onDeployed={refreshAll}
      />

      {versions?.repoUrl && !versionsError && (
        <Typography variant="caption" color="textSecondary">
          Versions from {versions.repoUrl.replace(/^https?:\/\//, '')}
        </Typography>
      )}

      <Divider className={classes.divider} />
      <RecentPipelineRuns runs={runs} error={runsError} />
    </InfoCard>
  );
};
