/** The slices of the Tekton API we actually read. */

export interface TektonCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export type TektonParamValue = string | string[] | Record<string, string>;

export interface TektonParam {
  name: string;
  value: TektonParamValue;
}

export interface ObjectMeta {
  name?: string;
  generateName?: string;
  namespace?: string;
  uid?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface PipelineResource {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec?: {
    params?: Array<{
      name: string;
      type?: 'string' | 'array' | 'object';
      description?: string;
      default?: TektonParamValue;
    }>;
    workspaces?: Array<{
      name: string;
      description?: string;
      optional?: boolean;
    }>;
  };
}

export interface PipelineRunResource {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec: {
    pipelineRef?: { name?: string };
    params?: TektonParam[];
    workspaces?: unknown[];
    taskRunTemplate?: { serviceAccountName?: string };
    timeouts?: { pipeline?: string };
    status?: string;
  };
  status?: {
    conditions?: TektonCondition[];
    startTime?: string;
    completionTime?: string;
    pipelineSpec?: PipelineResource['spec'];
    childReferences?: Array<{
      kind?: string;
      name?: string;
      pipelineTaskName?: string;
    }>;
  };
}

export interface TaskRunResource {
  metadata: ObjectMeta;
  spec?: { taskRef?: { name?: string } };
  status?: {
    conditions?: TektonCondition[];
    startTime?: string;
    completionTime?: string;
  };
}

export interface TektonList<T> {
  items?: T[];
}
