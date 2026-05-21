// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as k8s from "@pulumi/kubernetes"; //Import Pulumi Kubernetes Helm Support
import * as pulumi from "@pulumi/pulumi";

// Minikube does not implement services of type `LoadBalancer`; require the user to specify if we're
// running on minikube, and if so, create only services of type ClusterIP.
const config = new pulumi.Config();
const isMinikube = config.getBoolean("isMinikube");

//Create Monitoring Namespace
const monitoringNamespace = new k8s.core.v1.Namespace("monitoring", {
    metadata: {
        name: "monitoring",
    },
});

// Deploy kube-prometheus-stack using helm chart
const monitoring = new k8s.helm.v3.Release("kube-prometheus-stack", {
    chart: "kube-prometheus-stack",
    version: "58.2.1",
    namespace: monitoringNamespace.metadata.name,
    repositoryOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },

    values: {
        grafana: {
            adminPassword: "admin123",

            // service: {
            //     type: "LoadBalancer",
            // },
        },

        prometheus: {
            prometheusSpec: {
                serviceMonitorSelectorNilUsesHelmValues: false,
            },
        },
    },

// });
}, {// Wait for up to 15 minutes for all resources in the chart to become available
    customTimeouts: { create: "15m", update: "15m" }
});

// Full Minimal Monitoring Snippet
// const monitoring = new k8s.helm.v3.Release("monitoring", {
//     chart: "kube-prometheus-stack",

//     repositoryOpts: {
//         repo: "https://prometheus-community.github.io/helm-charts",
//     },

//     namespace: "monitoring",

//     values: {
//         grafana: {
//             adminPassword: "admin123",
//         },
//     },
// });

// Expose Guestbook Metrics by Add Sidecar Exporter
containers: [
    {
        name: "php-redis",
        image: "gcr.io/google_samples/gb-frontend:v4",
        ports: [{ containerPort: 80 }],
    },

    {
        name: "nginx-exporter",
        image: "nginx/nginx-prometheus-exporter:1.1.0",
        args: [
            "-nginx.scrape-uri=http://localhost:80/status"
        ],
        ports: [
            {
                containerPort: 9113,
                name: "metrics",
            },
        ],
    },
]

//Create a Service for Metrics
const frontendMetricsService = new k8s.core.v1.Service("frontend-metrics", {
    metadata: {
        labels: {
            app: "guestbook",
        },
    },

    spec: {
        selector: {
            app: "guestbook",
        },

        ports: [
            {
                name: "metrics",
                port: 9113,
                targetPort: "metrics",
            },
        ],
    },
});


//Create a ServiceMonitor; kube-prometheus-stack uses custom resources.
const serviceMonitor = new k8s.apiextensions.CustomResource("guestbook-monitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",

    metadata: {
        name: "guestbook-monitor",
        namespace: monitoringNamespace.metadata.name,
        labels: {
            release: "kube-prometheus-stack",
        },
    },

    spec: {
        selector: {
            matchLabels: {
                app: "guestbook",
            },
        },

        endpoints: [
            {
                port: "metrics",
                interval: "15s",
            },
        ],

        namespaceSelector: {
            any: true,
        },
    },
});

// Export Grafana URL
export const grafanaUrl =
    monitoring.status.namespace.apply(ns =>
        `http://localhost:3000`
    );


//If using Minikube:
//  kubectl port-forward svc/kube-prometheus-stack-758d46a1-grafana -n monitoring 3000:80
// Then open: http://localhost:3000

// Default Grafana Credentials
// username: admin
// password: admin123

// Access Prometheus
// kubectl port-forward svc/kube-prometheus-stack-758d-prometheus -n monitoring 9090
// Then Open: http://localhost:9090



//
// REDIS LEADER.
//

const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        template: {
            metadata: { labels: redisLeaderLabels },
            spec: {
                containers: [
                    {
                        name: "redis-leader",
                        image: "redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        ports: [{ containerPort: 6379 }],
                    },
                ],
            },
        },
    },
});
const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: {
        name: "redis-leader",
        labels: redisLeaderDeployment.metadata.labels,
    },
    spec: {
        ports: [{ port: 6379, targetPort: 6379 }],
        selector: redisLeaderDeployment.spec.template.metadata.labels,
    },
});

//
// REDIS REPLICA.
//

const redisReplicaLabels = { app: "redis-replica" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        template: {
            metadata: { labels: redisReplicaLabels },
            spec: {
                containers: [
                    {
                        name: "replica",
                        image: "pulumi/guestbook-redis-replica",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        // If your cluster config does not include a dns service, then to instead access an environment
                        // variable to find the leader's host, change `value: "dns"` to read `value: "env"`.
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 6379 }],
                    },
                ],
            },
        },
    },
});
const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: {
        name: "redis-replica",
        labels: redisReplicaDeployment.metadata.labels,
    },
    spec: {
        ports: [{ port: 6379, targetPort: 6379 }],
        selector: redisReplicaDeployment.spec.template.metadata.labels,
    },
});

//
// FRONTEND
//

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: { labels: frontendLabels },
            spec: {
                containers: [
                    {
                        name: "frontend",
                        image: "pulumi/guestbook-php-redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        // If your cluster config does not include a dns service, then to instead access an environment
                        // variable to find the master service's host, change `value: "dns"` to read `value: "env"`.
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" /* value: "env"*/ }],
                        ports: [{ containerPort: 80 }],
                    },
                ],
            },
        },
    },
});
const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        labels: frontendDeployment.metadata.labels,
        name: "frontend",
    },
    spec: {
        type: isMinikube ? "ClusterIP" : "LoadBalancer",
        ports: [{ port: 80 }],
        selector: frontendDeployment.spec.template.metadata.labels,
    },
});

// Export the frontend IP.
export let frontendIp: pulumi.Output<string>;
if (isMinikube) {
    frontendIp = frontendService.spec.clusterIP;
} else {
    frontendIp = frontendService.status.loadBalancer.ingress[0].ip;
}