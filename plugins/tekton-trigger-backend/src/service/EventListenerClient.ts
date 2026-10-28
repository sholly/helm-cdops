import fetch from 'node-fetch';
import { ServiceUnavailableError } from '@backstage/errors';
import { LoggerService } from '@backstage/backend-plugin-api';
import { EventListenerConfig } from './config';
import { TektonParamValue } from './tektonTypes';

export interface EventListenerPayload {
  source: 'backstage-tekton-trigger';
  entityRef: string;
  pipeline?: string;
  namespace?: string;
  triggeredBy?: string;
  params: Record<string, TektonParamValue>;
}

export interface EventListenerResult {
  name: string;
  status: number;
  eventId?: string;
}

/**
 * Fires a Tekton Triggers EventListener.
 *
 * The EventListener's TriggerBinding decides which PipelineRun gets created, so
 * this path is the one to prefer when the cluster team wants to keep that
 * decision on their side.
 */
export class EventListenerClient {
  constructor(private readonly logger: LoggerService) {}

  async send(
    listener: EventListenerConfig,
    payload: EventListenerPayload,
  ): Promise<EventListenerResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Backstage-Entity-Ref': payload.entityRef,
    };
    if (listener.secret) {
      headers[listener.secretHeader] = listener.secret;
    }

    let response;
    try {
      response = await fetch(listener.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new ServiceUnavailableError(
        `EventListener '${listener.name}' at ${listener.url} is unreachable: ${
          (error as Error).message
        }`,
      );
    }

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `EventListener '${listener.name}' returned ${response.status}: ${text}`,
      );
    }

    let eventId: string | undefined;
    try {
      eventId = (JSON.parse(text) as { eventID?: string }).eventID;
    } catch {
      // Triggers normally answers with JSON, but an interceptor in front of it
      // may not; the 2xx is the part that matters.
    }

    this.logger.info(
      `Fired EventListener '${listener.name}' for ${payload.entityRef}${
        eventId ? ` (eventID ${eventId})` : ''
      }`,
    );

    return { name: listener.name, status: response.status, eventId };
  }
}
