import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import { Link } from '@backstage/core-components';
import { PipelineRunSummary } from '@cdops/plugin-tekton-trigger-common';
import { PipelineRunStatusIndicator } from '../PipelineRunStatusIndicator';
import { formatDuration, formatRelativeTime } from '../../util';

const useStyles = makeStyles(theme => ({
  heading: {
    marginTop: theme.spacing(2),
    marginBottom: theme.spacing(0.5),
  },
  run: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    minHeight: theme.spacing(3),
  },
  detail: {
    color: theme.palette.text.secondary,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
}));

export interface RecentPipelineRunsProps {
  runs?: PipelineRunSummary[];
  error?: Error;
  /** How many runs to list. The card is a summary, not a history view. */
  limit?: number;
}

/**
 * The last few deploy pipelines, so the card can show that a deploy is in
 * flight without a separate history tab.
 */
export const RecentPipelineRuns = (props: RecentPipelineRunsProps) => {
  const { runs, error, limit = 3 } = props;
  const classes = useStyles();

  if (error) {
    return (
      <Box className={classes.heading}>
        <Typography variant="body2" color="error">
          Could not load pipeline runs: {error.message}
        </Typography>
      </Box>
    );
  }

  if (!runs?.length) {
    return null;
  }

  return (
    <Box>
      <Typography
        variant="subtitle2"
        color="textSecondary"
        className={classes.heading}
      >
        Recent pipelines
      </Typography>
      {runs.slice(0, limit).map(run => (
        <div key={run.name} className={classes.run}>
          <PipelineRunStatusIndicator
            status={run.status}
            reason={run.reason}
            message={run.message}
          />
          <Typography variant="body2" className={classes.detail}>
            {run.consoleUrl ? (
              <Link
                to={run.consoleUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {run.name}
              </Link>
            ) : (
              run.name
            )}{' '}
            · {formatRelativeTime(run.startedAt)} ·{' '}
            {formatDuration(run.durationMs)}
          </Typography>
        </div>
      ))}
    </Box>
  );
};
