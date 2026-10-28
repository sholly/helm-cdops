import { InputError } from '@backstage/errors';
import { TektonParamSpec } from '@cdops/plugin-tekton-trigger-common';
import { PipelineRunDefaults } from './config';
import {
  ENTITY_KIND_LABEL,
  ENTITY_NAME_LABEL,
  ENTITY_NAMESPACE_LABEL,
  ENTITY_REF_ANNOTATION,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  TRIGGERED_BY_ANNOTATION,
} from './labels';
import {
  PipelineRunResource,
  TektonParam,
  TektonParamValue,
} from './tektonTypes';
import { entityRefToLabels, ResolvedTarget } from './target';

/**
 * Validates caller-supplied parameters against the pipeline's declared ones and
 * merges in the values the catalog pins.
 *
 * Rejecting unknown parameters keeps a caller from smuggling values into a
 * pipeline that does not declare them, and rejecting pinned ones makes it
 * obvious when a form is out of date rather than silently ignoring input.
 */
export function resolveParams(options: {
  specs: TektonParamSpec[];
  supplied: Record<string, TektonParamValue>;
  fixed: Record<string, TektonParamValue>;
}): TektonParam[] {
  const { specs, supplied, fixed } = options;
  const byName = new Map(specs.map(spec => [spec.name, spec]));

  for (const name of Object.keys(supplied)) {
    if (!byName.has(name)) {
      throw new InputError(
        `Pipeline does not declare a parameter named '${name}'`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(fixed, name)) {
      throw new InputError(
        `Parameter '${name}' is fixed by the catalog and cannot be overridden`,
      );
    }
  }

  const params: TektonParam[] = [];

  for (const spec of specs) {
    const value = Object.prototype.hasOwnProperty.call(fixed, spec.name)
      ? fixed[spec.name]
      : supplied[spec.name];

    if (value === undefined || value === '') {
      if (spec.default === undefined) {
        throw new InputError(`Parameter '${spec.name}' is required`);
      }
      // Let Tekton apply the pipeline's own default.
      continue;
    }

    if (spec.type === 'array' && !Array.isArray(value)) {
      throw new InputError(`Parameter '${spec.name}' must be an array`);
    }
    if (spec.type !== 'array' && Array.isArray(value)) {
      throw new InputError(`Parameter '${spec.name}' must not be an array`);
    }

    params.push({ name: spec.name, value });
  }

  return params;
}

export function buildPipelineRun(options: {
  target: ResolvedTarget;
  params: TektonParam[];
  userEntityRef?: string;
  defaults: PipelineRunDefaults;
}): PipelineRunResource {
  const { target, params, userEntityRef, defaults } = options;

  if (!target.pipeline || !target.namespace) {
    throw new InputError(
      'Cannot build a PipelineRun without a pipeline and a namespace',
    );
  }

  const entityLabels = entityRefToLabels(target.entityRef);

  return {
    apiVersion: 'tekton.dev/v1',
    kind: 'PipelineRun',
    metadata: {
      // generateName lets the API server pick a unique suffix, so repeated
      // clicks never collide.
      generateName: `${target.pipeline}-`,
      namespace: target.namespace,
      labels: {
        ...defaults.labels,
        [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
        [ENTITY_KIND_LABEL]: entityLabels[ENTITY_KIND_LABEL],
        [ENTITY_NAMESPACE_LABEL]: entityLabels[ENTITY_NAMESPACE_LABEL],
        [ENTITY_NAME_LABEL]: entityLabels[ENTITY_NAME_LABEL],
      },
      annotations: {
        ...defaults.annotations,
        [ENTITY_REF_ANNOTATION]: target.entityRef,
        ...(userEntityRef ? { [TRIGGERED_BY_ANNOTATION]: userEntityRef } : {}),
      },
    },
    spec: {
      pipelineRef: { name: target.pipeline },
      ...(params.length ? { params } : {}),
      ...(target.workspaces?.length ? { workspaces: target.workspaces } : {}),
      ...(target.serviceAccountName
        ? { taskRunTemplate: { serviceAccountName: target.serviceAccountName } }
        : {}),
      timeouts: { pipeline: defaults.timeout },
    },
  };
}
