# Running Tekton Pipelines from Azure Devops pipelines: 

Broadly, there are 3 main ways to accomplish this task.  

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

* 1.  Openshift/Tekton CLI on an agent with a Service Account Token
ADO creates a PipelineRun, streams the logs and fails the ADO job if Tekton fails.

This option involves running the setup above.  This option requires the Openshift CLI 'oc', and the Tekton CLI 'tkn'.  It also requires an Openshift  ServiceAccount token.  Azure Devops will also require Openshift API server access to the cluster running pipelines.  This option will also stream the build logs back to the Azure pipeline, and report back on the status of the Pipeline run. 


* 2.  Openshift/Tekton CLI on an agent with an ADO Kubernetes Service connection. 

This option essentially does the same as Option 1, but with a Kubernetes Service Connection. I would argue that the Service Connection is the better approach for the following reasons: 
* The secret lives inside the service connection. 
* Built-in Azure Devops tasks can use it withouth further effort.  
* Key rotation just involves updating the Service Connection.     

Example ADO pipeline snippet.  
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

This involves setting up a TektonTrigger, EventListener, and the associated Openshift Route for an external route that Azure pipelines can call and start Tekton pipelines.  This option will require more work upfront, as the supporting Tekton objects need to be created, as well as the Markel DNS entry and TLS certificate.  

The big advantage is that whatever system calls the EventListener/Route is ONLY authorized to run whatever pipeline the EventListener is authorized to run.  Whereas the oc & tkn client has access to do whatever the caller's serviceacocunt is authorized to do.  

The big disadvantage is that the EventListener style of starting pipelines is 'fire-and-forget'.  There is no way of monitoring the Tekton pipeline for success, one has to trust that the triggered Tekton pipeline will be successful.  

The examples/azure-devops and examples/openshift directories have further examples on how to configure things.  