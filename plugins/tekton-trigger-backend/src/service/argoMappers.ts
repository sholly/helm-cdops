import {
  ArgoApplicationSummary,
  ArgoHealthStatus,
  ArgoOperationPhase,
  ArgoOperationState,
  ArgoSyncStatus,
  GitVersion,
} from '@cdops/plugin-tekton-trigger-common';

/**
 * The parts of an ArgoCD `Application` this plugin reads. The Roadie service
 * returns the raw API objects as `any`, so this narrows them in one place.
 */
export interface RawArgoApplication {
  metadata?: {
    name?: string;
    namespace?: string;
  };
  spec?: {
    project?: string;
    destination?: { namespace?: string };
    source?: RawArgoSource;
    sources?: RawArgoSource[];
  };
  status?: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string; message?: string };
    operationState?: {
      phase?: string;
      message?: string;
      startedAt?: string;
      finishedAt?: string;
      operation?: { sync?: { revision?: string } };
    };
    history?: { revision?: string; deployedAt?: string; id?: number }[];
    summary?: { images?: string[] };
  };
}

interface RawArgoSource {
  repoURL?: string;
  path?: string;
  targetRevision?: string;
}

const SYNC_STATUSES: ArgoSyncStatus[] = ['Synced', 'OutOfSync', 'Unknown'];
const HEALTH_STATUSES: ArgoHealthStatus[] = [
  'Healthy',
  'Progressing',
  'Degraded',
  'Suspended',
  'Missing',
  'Unknown',
];
const OPERATION_PHASES: ArgoOperationPhase[] = [
  'Running',
  'Succeeded',
  'Failed',
  'Error',
  'Terminating',
];

function oneOf<T extends string>(
  allowed: T[],
  value: string | undefined,
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * The source a multi-source Application tracks. We read the first one: a
 * multi-source app usually lists the chart repo first and value repos after.
 */
function primarySource(app: RawArgoApplication): RawArgoSource | undefined {
  return app.spec?.source ?? app.spec?.sources?.[0];
}

function toOperationState(
  app: RawArgoApplication,
): ArgoOperationState | undefined {
  const raw = app.status?.operationState;
  if (!raw?.phase) {
    return undefined;
  }
  return {
    phase: oneOf(OPERATION_PHASES, raw.phase, 'Running'),
    message: raw.message,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    revision: raw.operation?.sync?.revision,
  };
}

/** When the running revision was deployed, from the newest history entry. */
function deployedAt(app: RawArgoApplication): string | undefined {
  const history = app.status?.history;
  if (!history?.length) {
    return undefined;
  }
  // History is ordered oldest first, and `id` is monotonic.
  return [...history].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).at(-1)
    ?.deployedAt;
}

/** Deep link into the ArgoCD UI, which keys applications by name. */
export function argoApplicationUrl(
  instanceUrl: string | undefined,
  name: string | undefined,
): string | undefined {
  if (!instanceUrl || !name) {
    return undefined;
  }
  return `${instanceUrl.replace(/\/+$/, '')}/applications/${encodeURIComponent(
    name,
  )}`;
}

export function toArgoApplicationSummary(
  app: RawArgoApplication,
  options: { instance: string; instanceUrl?: string },
): ArgoApplicationSummary {
  const source = primarySource(app);
  const name = app.metadata?.name ?? '';

  return {
    name,
    instance: options.instance,
    namespace: app.spec?.destination?.namespace,
    project: app.spec?.project,
    syncStatus: oneOf(SYNC_STATUSES, app.status?.sync?.status, 'Unknown'),
    healthStatus: oneOf(HEALTH_STATUSES, app.status?.health?.status, 'Unknown'),
    healthMessage: app.status?.health?.message,
    revision: app.status?.sync?.revision,
    targetRevision: source?.targetRevision,
    repoUrl: source?.repoURL,
    path: source?.path,
    deployedAt: deployedAt(app),
    operationState: toOperationState(app),
    images: app.status?.summary?.images ?? [],
    argoUrl: argoApplicationUrl(options.instanceUrl, name),
  };
}

/** Newest deployment first, so the card's primary app is the freshest one. */
export function byNewestDeployment(
  a: ArgoApplicationSummary,
  b: ArgoApplicationSummary,
) {
  return (b.deployedAt ?? '').localeCompare(a.deployedAt ?? '');
}

export interface ToGitVersionsOptions {
  /** Revision ArgoCD is tracking, marked `current` in the result. */
  currentRevision?: string;
  includeBranches: boolean;
  includeTags: boolean;
  /** Only tags matching this regular expression are returned. */
  tagPattern?: RegExp;
  maxVersions: number;
}

/**
 * Turns ArgoCD's `{branches, tags}` into the dropdown's options: tags first
 * and newest first, since a tag is the normal thing to deploy, with branches
 * after for the teams that track one.
 */
export function toGitVersions(
  refs: { branches?: string[]; tags?: string[] },
  options: ToGitVersionsOptions,
): GitVersion[] {
  const tags = options.includeTags ? (refs.tags ?? []) : [];
  const branches = options.includeBranches ? (refs.branches ?? []) : [];

  const matched = options.tagPattern
    ? tags.filter(tag => options.tagPattern!.test(tag))
    : tags;

  const sortedTags = [...matched].sort((a, b) =>
    compareVersionsDescending(a, b),
  );

  const versions: GitVersion[] = [
    ...sortedTags.map(ref => ({ ref, type: 'tag' as const })),
    ...[...branches].sort().map(ref => ({ ref, type: 'branch' as const })),
  ];

  return versions
    .slice(0, options.maxVersions)
    .map(version =>
      version.ref === options.currentRevision
        ? { ...version, current: true }
        : version,
    );
}

/**
 * Semver-ish ordering, newest first, falling back to a natural-ish compare so
 * that `v1.10.0` sorts above `v1.9.0` rather than below it.
 */
export function compareVersionsDescending(a: string, b: string): number {
  const partsA = versionParts(a);
  const partsB = versionParts(b);

  if (partsA && partsB) {
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const diff = (partsB[i] ?? 0) - (partsA[i] ?? 0);
      if (diff !== 0) {
        return diff;
      }
    }
    // Same numbers: a plain tag outranks a pre-release of it (1.2.0 > 1.2.0-rc1).
    return a.length - b.length;
  }

  return b.localeCompare(a, undefined, { numeric: true });
}

function versionParts(ref: string): number[] | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(ref);
  if (!match) {
    return undefined;
  }
  return [match[1], match[2], match[3]].map(part => Number(part ?? 0));
}
