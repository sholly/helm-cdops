# Running Tekton Pipelines from Azure Devops pipelines: 

Broadly, there are 3 main ways to accomplish this task.  

* 1.  Openshift/Tekton CLI on an agent with a Service Account Token
ADO creates a PipelineRun, streams the logs and fails the ADO job if Tekton fails.


The following setup applies to options 1 and 2: 

```
- bash: |
    set -euo pipefail
    oc login --token="$OCP_TOKEN" --server="$OCP_SERVER"   # add --certificate-authority=... for a private CA
    PR=$(oc create -n my-ns -o name -f - <<EOF
    apiVersion: tekton.dev/v1
    kind: PipelineRun
    metadata:
      generateName: build-and-deploy-
      labels: { azure-devops/build-id: "$BUILD_BUILDID" }
    spec:
      pipelineRef: { name: build-and-deploy }
      params:
        - { name: git-revision, value: "$BUILD_SOURCEVERSION" }
      taskRunTemplate: { serviceAccountName: pipeline }
      workspaces:
        - name: shared
          volumeClaimTemplate:
            spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 1Gi } } }
    EOF
    )
    PR=${PR#*/}
    tkn pipelinerun logs "$PR" -n my-ns -f || true
    until [ -n "$(oc get pr "$PR" -n my-ns -o jsonpath='{.status.completionTime}')" ]; do sleep 10; done
    STATUS=$(oc get pr "$PR" -n my-ns -o jsonpath='{.status.conditions[?(@.type=="Succeeded")].status}')
    [ "$STATUS" = "True" ] || { echo "##vso[task.logissue type=error]PipelineRun $PR failed"; exit 1; }
  env:
    OCP_TOKEN: $(ocpToken)     # secret variables must be mapped explicitly
    OCP_SERVER: $(ocpServer)
```

* 2.  Openshift/Tekton CLI on an agent with an ADO Kubernetes Service connection. 

```
- task: Kubernetes@1
  inputs:
    connectionType: Kubernetes Service Connection
    kubernetesServiceEndpoint: my-openshift   # kubeconfig or SA-token based connection
    command: login                            # sets KUBECONFIG for the following steps
- bash: |
    kubectl create -n my-ns -f tekton/pipelinerun.yaml -
```

* 3.  Webhook to a Tekton Triggers EventListener

```
apiVersion: triggers.tekton.dev/v1beta1
kind: EventListener
metadata: { name: azdo-listener, namespace: my-ns }
spec:
  serviceAccountName: pipeline
  triggers:
    - name: azdo
      interceptors:
        - ref: { name: cel }
          params:
            - name: filter
              value: "header.canonical('X-Azdo-Token').compareSecret('token', 'azdo-webhook-secret')"
      bindings:
        - { name: git-revision, value: $(body.revision) }
        - { name: build-id,     value: $(body.buildId) }
      template: { ref: build-and-deploy-template }   
```