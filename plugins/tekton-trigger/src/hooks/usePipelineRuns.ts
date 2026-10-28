import { useCallback, useEffect, useState } from 'react';
import { useApi } from '@backstage/core-plugin-api';
import {
  isPipelineRunComplete,
  PipelineRunSummary,
} from '@cdops/plugin-tekton-trigger-common';
import { tektonTriggerApiRef } from '../api';

/** Poll faster while a run is in flight, slower when everything is settled. */
const ACTIVE_INTERVAL_MS = 5_000;
const IDLE_INTERVAL_MS = 20_000;

export interface PipelineRunsState {
  runs?: PipelineRunSummary[];
  loading: boolean;
  error?: Error;
  refresh: () => void;
}

export function usePipelineRuns(
  entityRef: string,
  enabled = true,
): PipelineRunsState {
  const api = useApi(tektonTriggerApiRef);
  const [state, setState] = useState<{
    runs?: PipelineRunSummary[];
    loading: boolean;
    error?: Error;
  }>({ loading: true });
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce(current => current + 1), []);

  useEffect(() => {
    if (!enabled) {
      setState({ loading: false, runs: [] });
      return undefined;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const runs = await api.listPipelineRuns(entityRef);
        if (cancelled) {
          return;
        }
        setState({ loading: false, runs });

        const active = runs.some(run => !isPipelineRunComplete(run.status));
        timer = setTimeout(
          tick,
          active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS,
        );
      } catch (error) {
        if (cancelled) {
          return;
        }
        // Stop polling on failure rather than hammering a broken cluster; the
        // table offers an explicit retry.
        setState({ loading: false, error: error as Error });
      }
    };

    tick();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [api, entityRef, enabled, nonce]);

  return { ...state, refresh };
}
