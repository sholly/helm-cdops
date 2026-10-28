import { useMemo, useState } from 'react';
import Button from '@material-ui/core/Button';
import CircularProgress from '@material-ui/core/CircularProgress';
import Dialog from '@material-ui/core/Dialog';
import DialogActions from '@material-ui/core/DialogActions';
import DialogContent from '@material-ui/core/DialogContent';
import DialogContentText from '@material-ui/core/DialogContentText';
import DialogTitle from '@material-ui/core/DialogTitle';
import TextField from '@material-ui/core/TextField';
import Alert from '@material-ui/lab/Alert';
import { alertApiRef, useApi } from '@backstage/core-plugin-api';
import {
  TektonParamSpec,
  TektonTarget,
  TriggerPipelineResponse,
} from '@cdops/plugin-tekton-trigger-common';
import { tektonTriggerApiRef } from '../../api';

export interface TriggerPipelineDialogProps {
  open: boolean;
  entityRef: string;
  target: TektonTarget;
  onClose: () => void;
  onTriggered?: (response: TriggerPipelineResponse) => void;
}

function defaultValue(spec: TektonParamSpec): string {
  if (spec.default === undefined) {
    return '';
  }
  if (Array.isArray(spec.default)) {
    return spec.default.join(', ');
  }
  return typeof spec.default === 'object'
    ? JSON.stringify(spec.default)
    : String(spec.default);
}

/** Array params are typed as a comma-separated list in the form. */
function toParamValue(
  spec: TektonParamSpec,
  raw: string,
): string | string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (spec.type === 'array') {
    const items = trimmed
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
    return items.length ? items : undefined;
  }
  return trimmed;
}

export const TriggerPipelineDialog = (props: TriggerPipelineDialogProps) => {
  const { open, entityRef, target, onClose, onTriggered } = props;
  const api = useApi(tektonTriggerApiRef);
  const alertApi = useApi(alertApiRef);

  const editable = useMemo(
    () => target.params.filter(param => !param.fixed),
    [target.params],
  );
  const fixed = useMemo(
    () => target.params.filter(param => param.fixed),
    [target.params],
  );

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(editable.map(spec => [spec.name, defaultValue(spec)])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  const missingRequired = editable.filter(
    spec => spec.default === undefined && !values[spec.name]?.trim(),
  );

  const submit = async () => {
    setSubmitting(true);
    setError(undefined);

    try {
      const params: Record<string, string | string[]> = {};
      for (const spec of editable) {
        const value = toParamValue(spec, values[spec.name] ?? '');
        if (value !== undefined) {
          params[spec.name] = value;
        }
      }

      const response = await api.triggerPipeline({ entityRef, params });

      alertApi.post({
        message:
          response.mode === 'pipelineRun'
            ? `Started ${response.pipelineRun?.name}`
            : `Fired EventListener ${response.eventListener?.name}`,
        severity: 'success',
        display: 'transient',
      });

      onTriggered?.(response);
      onClose();
    } catch (triggerError) {
      setError(triggerError as Error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {target.mode === 'eventListener'
          ? `Trigger ${target.eventListener}`
          : `Run ${target.pipeline}`}
      </DialogTitle>

      <DialogContent>
        <DialogContentText>
          {target.mode === 'eventListener'
            ? `Sends an event to the ${target.eventListener} EventListener, which decides what to run.`
            : `Creates a PipelineRun in ${target.namespace} on ${target.cluster}.`}
        </DialogContentText>

        {error && (
          <Alert severity="error" style={{ marginBottom: 16 }}>
            {error.message}
          </Alert>
        )}

        {editable.map(spec => (
          <TextField
            key={spec.name}
            id={`tekton-param-${spec.name}`}
            label={spec.name}
            value={values[spec.name] ?? ''}
            onChange={event =>
              setValues(current => ({
                ...current,
                [spec.name]: event.target.value,
              }))
            }
            helperText={
              spec.type === 'array'
                ? [spec.description, 'Comma-separated list']
                    .filter(Boolean)
                    .join(' — ')
                : spec.description
            }
            required={spec.default === undefined}
            fullWidth
            margin="dense"
            variant="outlined"
          />
        ))}

        {fixed.map(spec => (
          <TextField
            key={spec.name}
            id={`tekton-fixed-param-${spec.name}`}
            label={`${spec.name} (set by the catalog)`}
            value="—"
            helperText={spec.description}
            disabled
            fullWidth
            margin="dense"
            variant="outlined"
          />
        ))}

        {!editable.length && !fixed.length && (
          <DialogContentText>
            This pipeline takes no parameters.
          </DialogContentText>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          color="primary"
          variant="contained"
          onClick={submit}
          disabled={submitting || missingRequired.length > 0}
          startIcon={
            submitting ? (
              <CircularProgress size={16} color="inherit" />
            ) : undefined
          }
        >
          {submitting ? 'Starting…' : 'Run'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
