import { useCallback } from 'react';
import useAsync from 'react-use/esm/useAsync';
import { useApi } from '@backstage/core-plugin-api';
import { ListGitVersionsResponse } from '@cdops/plugin-tekton-trigger-common';
import { tektonTriggerApiRef } from '../api';

export interface GitVersionsState {
  versions?: ListGitVersionsResponse;
  loading: boolean;
  error?: Error;
}

/**
 * Loads the git versions for the dropdown. Not polled: refs change on a human
 * timescale, and the list is reloaded whenever the picked application changes.
 */
export function useGitVersions(
  entityRef: string,
  app: string | undefined,
  enabled = true,
): GitVersionsState {
  const api = useApi(tektonTriggerApiRef);

  const load = useCallback(async () => {
    if (!enabled) {
      return undefined;
    }
    return await api.listGitVersions(entityRef, app);
  }, [api, entityRef, app, enabled]);

  const { value, loading, error } = useAsync(load, [load]);

  return { versions: value, loading, error };
}
