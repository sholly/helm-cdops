import Box from '@material-ui/core/Box';
import Chip from '@material-ui/core/Chip';
import Tooltip from '@material-ui/core/Tooltip';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import { Link } from '@backstage/core-components';
import { ArgoApplicationSummary } from '@cdops/plugin-tekton-trigger-common';
import { formatRelativeTime, formatTimestamp } from '../../util';
import {
  ArgoHealthStatusIndicator,
  ArgoOperationIndicator,
  ArgoSyncStatusIndicator,
} from './ArgoStatusIndicator';

const useStyles = makeStyles(theme => ({
  statuses: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing(2),
  },
  rows: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    columnGap: theme.spacing(2),
    rowGap: theme.spacing(0.5),
    marginTop: theme.spacing(1.5),
  },
  revision: {
    fontFamily: theme.typography.fontFamily,
    wordBreak: 'break-all',
  },
  images: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(0.5),
    marginTop: theme.spacing(1),
  },
}));

/** Short form of a git revision: a commit SHA is abbreviated, a tag is not. */
export function shortRevision(revision: string | undefined): string {
  if (!revision) {
    return '—';
  }
  return /^[0-9a-f]{40}$/i.test(revision) ? revision.slice(0, 7) : revision;
}

const Row = (props: { label: string; children: React.ReactNode }) => (
  <>
    <Typography variant="body2" color="textSecondary">
      {props.label}
    </Typography>
    <Typography variant="body2" component="div">
      {props.children}
    </Typography>
  </>
);

/** What ArgoCD currently has deployed for one application. */
export const DeployedState = (props: { app: ArgoApplicationSummary }) => {
  const { app } = props;
  const classes = useStyles();

  const operation = app.operationState;
  // Only worth showing while it matters: a long-finished successful sync is
  // already implied by the sync status.
  const showOperation =
    operation &&
    (operation.phase === 'Running' ||
      operation.phase === 'Terminating' ||
      operation.phase === 'Failed' ||
      operation.phase === 'Error');

  return (
    <Box>
      <div className={classes.statuses}>
        <ArgoSyncStatusIndicator
          status={app.syncStatus}
          revision={app.revision}
        />
        <ArgoHealthStatusIndicator
          status={app.healthStatus}
          message={app.healthMessage}
        />
        {showOperation && (
          <ArgoOperationIndicator
            phase={operation!.phase}
            message={operation!.message}
          />
        )}
      </div>

      <div className={classes.rows}>
        <Row label="Deployed">
          <span className={classes.revision}>
            {shortRevision(app.revision)}
          </span>
          {app.deployedAt && (
            <Tooltip title={formatTimestamp(app.deployedAt)}>
              <span> · {formatRelativeTime(app.deployedAt)}</span>
            </Tooltip>
          )}
        </Row>

        <Row label="Tracking">
          <span className={classes.revision}>{app.targetRevision ?? '—'}</span>
        </Row>

        {app.revisionInfo?.message && (
          <Row label="Commit">
            {app.revisionInfo.message.split('\n')[0]}
            {app.revisionInfo.author && ` — ${app.revisionInfo.author}`}
          </Row>
        )}

        {app.namespace && <Row label="Namespace">{app.namespace}</Row>}

        {app.repoUrl && (
          <Row label="Source">
            <Link to={app.repoUrl} target="_blank" rel="noopener noreferrer">
              {app.repoUrl.replace(/^https?:\/\//, '')}
            </Link>
            {app.path && app.path !== '.' && ` · ${app.path}`}
          </Row>
        )}
      </div>

      {app.images.length > 0 && (
        <div className={classes.images}>
          {app.images.map(image => (
            <Tooltip key={image} title={image}>
              <Chip size="small" variant="outlined" label={shortImage(image)} />
            </Tooltip>
          ))}
        </div>
      )}
    </Box>
  );
};

/** Registry paths are long and the tag is the part worth reading at a glance. */
function shortImage(image: string): string {
  const [path, tag] = image.split(/:(?=[^:/]+$)/);
  const name = path.split('/').pop() ?? path;
  return tag ? `${name}:${tag}` : name;
}
