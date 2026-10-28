import { useCallback } from 'react';
import useAsync from 'react-use/esm/useAsync';
import { useApi } from '@backstage/core-plugin-api';
import { TektonTarget } from '@cdops/plugin-tekton-trigger-common';
import { tektonTriggerApiRef } from '../api';

/** Loads what the entity is allowed to run, including the pipeline's params. */
export function useTektonTarget(entityRef: string) {
  const api = useApi(tektonTriggerApiRef);

  const load = useCallback(
    async () => await api.getTarget(entityRef),
    [api, entityRef],
  );

  const { value, loading, error } = useAsync(load, [load]);

  return {
    target: value as TektonTarget | undefined,
    loading,
    error,
  };
}
