import { useCallback, useEffect, useState } from 'react';
import { useApi } from '@backstage/core-plugin-api';
import {
  ArgoDeployedState,
  isArgoAppSettling,
} from '@cdops/plugin-tekton-trigger-common';
import { tektonTriggerApiRef } from '../api';

/**
 * Poll faster while ArgoCD is still converging on a revision, slower once it
 * has settled. A deploy is slow enough that a settled app rarely changes.
 */
const SETTLING_INTERVAL_MS = 5_000;
const IDLE_INTERVAL_MS = 30_000;

export interface ArgoApplicationState {
  state?: ArgoDeployedState;
  loading: boolean;
  error?: Error;
  refresh: () => void;
}

/** Loads and polls the deployed state of the entity's ArgoCD applications. */
export function useArgoApplication(entityRef: string): ArgoApplicationState {
  const api = useApi(tektonTriggerApiRef);
  const [result, setResult] = useState<{
    state?: ArgoDeployedState;
    loading: boolean;
    error?: Error;
  }>({ loading: true });
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce(current => current + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const state = await api.getArgoApplication(entityRef);
        if (cancelled) {
          return;
        }
        setResult({ loading: false, state });

        const settling = state.apps.some(isArgoAppSettling);
        timer = setTimeout(
          tick,
          settling ? SETTLING_INTERVAL_MS : IDLE_INTERVAL_MS,
        );
      } catch (error) {
        if (cancelled) {
          return;
        }
        // Stop polling on failure rather than hammering a broken instance;
        // the card offers an explicit retry.
        setResult({ loading: false, error: error as Error });
      }
    };

    tick();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [api, entityRef, nonce]);

  return { ...result, refresh };
}
