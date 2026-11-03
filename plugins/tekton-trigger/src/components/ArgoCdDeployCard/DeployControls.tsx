import { useEffect, useMemo, useState } from 'react';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import CircularProgress from '@material-ui/core/CircularProgress';
import Dialog from '@material-ui/core/Dialog';
import DialogActions from '@material-ui/core/DialogActions';
import DialogContent from '@material-ui/core/DialogContent';
import DialogContentText from '@material-ui/core/DialogContentText';
import DialogTitle from '@material-ui/core/DialogTitle';
import FormControl from '@material-ui/core/FormControl';
import InputLabel from '@material-ui/core/InputLabel';
import ListSubheader from '@material-ui/core/ListSubheader';
import MenuItem from '@material-ui/core/MenuItem';
import Select from '@material-ui/core/Select';
import Tooltip from '@material-ui/core/Tooltip';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import { alertApiRef, useApi } from '@backstage/core-plugin-api';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  ArgoApplicationSummary,
  GitVersion,
  tektonPipelineTriggerPermission,
} from '@cdops/plugin-tekton-trigger-common';
import { tektonTriggerApiRef } from '../../api';

const useStyles = makeStyles(theme => ({
  controls: {
    display: 'flex',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: theme.spacing(2),
    marginTop: theme.spacing(2),
  },
  select: {
    minWidth: 220,
  },
  current: {
    marginLeft: theme.spacing(1),
    color: theme.palette.text.secondary,
  },
}));

export interface DeployControlsProps {
  entityRef: string;
  app: ArgoApplicationSummary;
  versions: GitVersion[];
  versionsLoading: boolean;
  /** Why the dropdown is empty, when it is. */
  unavailableReason?: string;
  /** Called once a pipeline has been started, to refresh state and runs. */
  onDeployed: () => void;
}

/**
 * The version dropdown and the deploy button.
 *
 * Deploying does not change ArgoCD directly: it runs the entity's pipeline,
 * which is what updates the version ArgoCD deploys. The confirmation step
 * exists because that pipeline writes to a real environment.
 */
export const DeployControls = (props: DeployControlsProps) => {
  const {
    entityRef,
    app,
    versions,
    versionsLoading,
    unavailableReason,
    onDeployed,
  } = props;
  const classes = useStyles();
  const api = useApi(tektonTriggerApiRef);
  const alertApi = useApi(alertApiRef);

  const [selected, setSelected] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [deploying, setDeploying] = useState(false);

  const { allowed: canDeploy, loading: permissionLoading } = usePermission({
    permission: tektonPipelineTriggerPermission,
  });

  // Default to what ArgoCD already tracks, so the dropdown opens on the
  // version the reader is looking at rather than an arbitrary one.
  useEffect(() => {
    const current = versions.find(version => version.current);
    setSelected(current?.ref ?? versions[0]?.ref ?? '');
  }, [versions]);

  const { tags, branches } = useMemo(
    () => ({
      tags: versions.filter(version => version.type === 'tag'),
      branches: versions.filter(version => version.type === 'branch'),
    }),
    [versions],
  );

  const deploy = async () => {
    setConfirming(false);
    setDeploying(true);
    try {
      const result = await api.deploy({
        entityRef,
        version: selected,
        app: app.name,
      });

      alertApi.post({
        message:
          result.mode === 'eventListener'
            ? `Requested deploy of ${app.name} at ${selected}`
            : `Started ${result.pipelineRun?.name} to deploy ${app.name} at ${selected}`,
        severity: 'success',
        display: 'transient',
      });
      onDeployed();
    } catch (error) {
      alertApi.post({
        message: `Could not deploy ${app.name} at ${selected}: ${
          (error as Error).message
        }`,
        severity: 'error',
      });
    } finally {
      setDeploying(false);
    }
  };

  if (unavailableReason) {
    return (
      <Box mt={2}>
        <Typography variant="body2" color="textSecondary">
          {unavailableReason}
        </Typography>
      </Box>
    );
  }

  const noVersions = !versionsLoading && versions.length === 0;
  const disabled =
    !selected || deploying || versionsLoading || !canDeploy || noVersions;

  const deployButton = (
    <Button
      color="primary"
      variant="contained"
      disabled={disabled}
      onClick={() => setConfirming(true)}
      startIcon={
        deploying ? <CircularProgress size={16} color="inherit" /> : undefined
      }
    >
      {deploying ? 'Deploying…' : 'Deploy'}
    </Button>
  );

  return (
    <>
      <div className={classes.controls}>
        <FormControl className={classes.select} size="small">
          <InputLabel id={`version-label-${app.name}`}>Version</InputLabel>
          <Select
            labelId={`version-label-${app.name}`}
            value={selected}
            disabled={versionsLoading || noVersions}
            onChange={event => setSelected(event.target.value as string)}
          >
            {noVersions && (
              <MenuItem value="" disabled>
                No versions found
              </MenuItem>
            )}
            {tags.length > 0 && (
              <ListSubheader disableSticky>Tags</ListSubheader>
            )}
            {tags.map(version => (
              <MenuItem key={`tag-${version.ref}`} value={version.ref}>
                {version.ref}
                {version.current && (
                  <span className={classes.current}>(current)</span>
                )}
              </MenuItem>
            ))}
            {branches.length > 0 && (
              <ListSubheader disableSticky>Branches</ListSubheader>
            )}
            {branches.map(version => (
              <MenuItem key={`branch-${version.ref}`} value={version.ref}>
                {version.ref}
                {version.current && (
                  <span className={classes.current}>(current)</span>
                )}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {canDeploy || permissionLoading ? (
          deployButton
        ) : (
          <Tooltip title="You do not have permission to trigger this pipeline">
            <span>{deployButton}</span>
          </Tooltip>
        )}
      </div>

      <Dialog open={confirming} onClose={() => setConfirming(false)}>
        <DialogTitle>Deploy {app.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This runs the entity's pipeline to set {app.name} to{' '}
            <strong>{selected}</strong>
            {app.namespace ? ` in ${app.namespace}` : ''}. ArgoCD picks the
            change up once the pipeline has finished.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
          <Button color="primary" variant="contained" onClick={deploy}>
            Deploy {selected}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
