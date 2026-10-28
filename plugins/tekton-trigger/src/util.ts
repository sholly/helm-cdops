/** Human duration for a PipelineRun, e.g. `4m 12s`. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return '—';
  }

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/** Short relative time, e.g. `3 minutes ago`. */
export function formatRelativeTime(timestamp: string | undefined): string {
  if (!timestamp) {
    return '—';
  }

  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return timestamp;
  }

  const deltaSeconds = Math.round((parsed - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 30],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];

  let value = deltaSeconds;
  for (const [unit, limit] of units) {
    if (Math.abs(value) < limit) {
      return new Intl.RelativeTimeFormat(undefined, {
        numeric: 'auto',
      }).format(Math.round(value), unit);
    }
    value /= limit;
  }
  return timestamp;
}

export function formatTimestamp(timestamp: string | undefined): string {
  if (!timestamp) {
    return '—';
  }
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? timestamp : new Date(parsed).toLocaleString();
}
