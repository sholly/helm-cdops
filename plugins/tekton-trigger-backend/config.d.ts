export interface Config {
  tektonTrigger?: {
    /**
     * Cluster used when an entity has no `tekton.dev/cluster` annotation.
     * Optional when exactly one cluster is configured.
     */
    defaultCluster?: string;

    /** Clusters the plugin is allowed to create PipelineRuns on. */
    clusters?: Array<{
      /** Name referenced by the `tekton.dev/cluster` annotation. */
      name: string;

      /** API server base URL, e.g. `https://api.ocp.example.com:6443`. */
      url: string;

      /**
       * Bearer token of a ServiceAccount with the Tekton RBAC from
       * `examples/openshift/rbac.yaml`.
       * @visibility secret
       */
      serviceAccountToken?: string;

      /**
       * Path to a file holding the bearer token. Re-read on every request, so
       * projected ServiceAccount tokens rotate without a restart. Defaults to
       * the in-cluster path when neither token option is set.
       */
      serviceAccountTokenFile?: string;

      /**
       * base64-encoded PEM bundle used to verify the API server certificate.
       * @visibility secret
       */
      caData?: string;

      /** Path to a PEM bundle used to verify the API server certificate. */
      caFile?: string;

      /** Skip API server certificate verification. Never use outside dev. */
      skipTLSVerify?: boolean;

      /** Base URL used to build deep links, e.g. `https://console-openshift-console.apps.ocp.example.com`. */
      dashboardUrl?: string;

      /** Link format for `dashboardUrl`. Defaults to `openshift`. */
      dashboardType?: 'openshift' | 'tekton';

      /**
       * Namespaces the plugin may touch on this cluster. When set, an entity
       * annotated with any other namespace is rejected.
       */
      allowedNamespaces?: string[];
    }>;

    /** Tekton Triggers EventListeners that entities may fire. */
    eventListeners?: Array<{
      /** Name referenced by the `tekton.dev/event-listener` annotation. */
      name: string;

      /** Full URL of the EventListener route or service. */
      url: string;

      /**
       * Secret sent with the request so the EventListener's interceptor can
       * verify it.
       * @visibility secret
       */
      secret?: string;

      /** Header carrying `secret`. Defaults to `X-Backstage-Token`. */
      secretHeader?: string;

      /** Cluster whose `dashboardUrl` is used for deep links. */
      cluster?: string;

      /** Namespace recorded on the request payload. */
      namespace?: string;
    }>;

    /** Defaults applied to every PipelineRun this plugin creates. */
    pipelineRun?: {
      /** ServiceAccount the TaskRuns run as, unless the entity overrides it. */
      serviceAccountName?: string;

      /** Tekton timeout for the whole pipeline, e.g. `1h0m0s`. Defaults to `1h0m0s`. */
      timeout?: string;

      /** Extra labels added to every PipelineRun. */
      labels?: { [key: string]: string };

      /** Extra annotations added to every PipelineRun. */
      annotations?: { [key: string]: string };
    };

    /** Maximum number of PipelineRuns returned per entity. Defaults to 20. */
    maxRuns?: number;
  };
}
