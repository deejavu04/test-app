// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as k8s from "@pulumi/kubernetes"; //Import Pulumi Kubernetes Helm Support
import * as pulumi from "@pulumi/pulumi";

// Minikube does not implement services of type `LoadBalancer`; require the user to specify if we're
// running on minikube, and if so, create only services of type ClusterIP.
const config = new pulumi.Config();
// const isMinikube = config.getBoolean("isMinikube");
const isMinikube = config.getBoolean("isMinikube") || false;

// You eill see in the output of the pulumi up command in the terminal
console.log("isMinikube =", isMinikube);

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
        // grafana: {
        //     adminPassword: "admin123",

        //     // service: {
        //     //     type: "LoadBalancer",
        //     // },
        //     service: {
        //         type: "NodePort",
        //         nodePort: 32000
        //     },
        // },
        grafana: {
        //     adminPassword: "admin123",
        //     service: {
        //         type: isMinikube ? "ClusterIP" : "NodePort",
        //         nodePort: 32000,
        //     },
        // },

        // prometheus: {
        //     prometheusSpec: {
        //         // FEserviceMonitorSelectorNilUsesHelmValues: false,
        //         serviceMonitorSelectorNilUsesHelmValues: false
        //     },
        // },
        grafana: {
            service: {
                type: "NodePort",
            },
        },
        prometheus: {
            service: {
                type: "ClusterIP",
            },
        },
        alertmanager: {
            enabled: false,
        },
        // important for Minikube stability
        // Add Kubernetes-level monitoring (works immediately)

        // This gives you:

        // CPU usage
        // memory usage
        // pod restarts
        // deployment scaling
        kubeStateMetrics: {
            enabled: true,
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


// Export Grafana URL
// export const grafanaUrl =
//     monitoring.status.namespace.apply(ns =>
//         `http://localhost:3000`
//         // `http://${minikubeIP}:32000`
//     );

// const grafanaService = monitoring.getResource("v1/Service", "monitoring-grafana");

// export const grafanaUrl = grafanaService.apply(svc => {
//     const nodePort = svc.spec.ports[0].nodePort;
//     return isMinikube
//         ? `http://localhost:${nodePort}`
//         : `http://<NODE_IP>:${nodePort}`;
// });

// export const grafanaPassword = monitoring.getResource("v1/Secret", "monitoring-grafana")
//     .apply(secret =>
//         Buffer.from(secret.data["admin-password"], "base64").toString()
//     );

// Access Grafana (If not using NodePort with Minikube):
//  kubectl port-forward svc/kube-prometheus-stack-758d46a1-grafana -n monitoring 3000:80
// Then open: http://localhost:3000

// Default Grafana Credentials
// username: admin
// password: admin123

// Access Prometheus
// kubectl port-forward svc/kube-prometheus-stack-758d-prometheus -n monitoring 9090
// Then Open: http://localhost:9090


//
// BACKEND
//

// REDIS LEADER.
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
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.66.0",
                        env: [
                            {
                                name: "REDIS_ADDR",
                                value: "redis://localhost:6379",
                            },
                        ],
                        ports: [{ containerPort: 9121, name: "metrics" }],
                    },
                ],
            },
        },
    },
});

const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: {
        name: "redis-leader",
        // labels: redisLeaderDeployment.metadata.labels,
        labels: redisLeaderLabels,
    },
    spec: {
        // ports: [{ port: 6379, targetPort: 6379 }],
        // ports: [{ name: "leader-metrics", port: 6379, targetPort: 6379 }],
        ports: [
            {
                name: "redis",
                port: 6379,
                targetPort: 6379,
            },
            {
                name: "metrics",
                port: 9121,
                targetPort: 9121,
            },
        ],
        selector: redisLeaderDeployment.spec.template.metadata.labels,
    },
});

const redisLeaderServiceMonitor = new k8s.apiextensions.CustomResource(
    "redis-leader-sm",
    {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: {
            name: "redis-leader-sm",
        },
        spec: {
            selector: {
                matchLabels: redisLeaderLabels,
            },
            endpoints: [
                {
                    port: "6379",
                    interval: "10s",
                },
            ],
        },
    },
    { dependsOn: monitoring }
);

// const redisLeaderServiceMonitor = new k8s.apiextensions.CustomResource("redis-leader-monitor", {
//     apiVersion: "monitoring.coreos.com/v1",
//     kind: "ServiceMonitor",

//     metadata: {
//         name: "redis-leader-monitor",
//         namespace: "monitoring",

//         // Without this label, Prometheus may ignore the ServiceMonitor depending on Helm values.
//         labels: {
//             release: "kube-prometheus-stack",
//         },
//     },

//     spec: {
//         selector: {
//             matchLabels: {
//                 app: "redis-leader",
//             },
//         },

//         // namespaceSelector: {
//         //     any: true,
//         // },
//         namespaceSelector: {
//             matchNames: ["default"],
//         },

//         // endpoints: [
//         //     {
//         //         port: "leader-metrics",
//         //         path: "/metrics",
//         //         interval: "15s",
//         //     },
//         // ],
//         endpoints: [
//             {
//                 port: "metrics",
//                 path: "/metrics",
//                 interval: "15s",
//             },
//         ],
//     },
// });

// REDIS REPLICA
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
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.66.0",
                        env: [
                            {
                                name: "REDIS_ADDR",
                                value: "redis://localhost:6379",
                            },
                        ],
                        ports: [
                            {
                                name: "metrics",
                                containerPort: 9121,
                            },
                        ],
                    }
                ],
            },
        },
    },
});

const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: {
        name: "redis-replica",
        // labels: redisReplicaDeployment.metadata.labels,
        labels: redisReplicaLabels,
    },
    spec: {
        // ports: [{ port: 6379, targetPort: 6379 }],
        // ports: [{ name: "replica-metrics", port: 6379, targetPort: 6379 }],
        ports: [
            {
                name: "redis",
                port: 6379,
                targetPort: 6379,
            },
            {
                name: "metrics",
                port: 9121,
                targetPort: 9121,
            },
        ],
        selector: redisReplicaDeployment.spec.template.metadata.labels,
    },
});

const redisReplicaServiceMonitor = new k8s.apiextensions.CustomResource(
    "redis-replica-sm",
    {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: {
            name: "redis-replica-sm",
        },
        spec: {
            selector: {
                matchLabels: redisReplicaLabels,
            },
            endpoints: [
                {
                    port: "6379",
                    interval: "10s",
                },
            ],
        },
    },
    { dependsOn: monitoring }
);

// const redisReplicaServiceMonitor = new k8s.apiextensions.CustomResource("redis-replica-monitor", {
//     apiVersion: "monitoring.coreos.com/v1",
//     kind: "ServiceMonitor",

//     metadata: {
//         name: "redis-replica-monitor",
//         namespace: "monitoring",

//         // Without this label, Prometheus may ignore the ServiceMonitor depending on Helm values.
//         labels: {
//             release: "kube-prometheus-stack",
//         },
//     },

//     spec: {
//         selector: {
//             matchLabels: {
//                 app: "redis-replica",
//             },
//         },

//         namespaceSelector: {
//             any: true,
//         },
//         // namespaceSelector: {
//         //     matchNames: ["default"],
//         // },

//         endpoints: [
//             {
//                 port: "metrics",
//                 path: "/metrics",
//                 interval: "15s",
//             },
//         ],
//     },
// });


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
                // containers: [
                //     {
                //         name: "frontend",
                //         image: "pulumi/guestbook-php-redis",
                //         resources: { requests: { cpu: "100m", memory: "100Mi" } },
                //         // If your cluster config does not include a dns service, then to instead access an environment
                //         // variable to find the master service's host, change `value: "dns"` to read `value: "env"`.
                //         env: [{ name: "GET_HOSTS_FROM", value: "dns" /* value: "env"*/ }],
                //         ports: [{ containerPort: 80 }],
                //     },
                // ],
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

                    // Expose Guestbook Metrics by Add Sidecar Exporter
                    {
                        name: "nginx-exporter",
                        image: "nginx/nginx-prometheus-exporter:1.1.0",

                        // args: [
                        //     "-nginx.scrape-uri=http://localhost:80/status",
                        // ],
                        // fixess
                        args: [
                            "-nginx.scrape-uri=http://127.0.0.1/nginx_status",
                        ],

                        ports: [
                            {
                                name: "fe-metrics",
                                containerPort: 9113,
                            },
                        ],
                    },
                ],
            },
        },
    },
});

const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        namespace: "default", //added by me
        // labels: frontendDeployment.metadata.labels,
        // labels: frontendDeployment.spec.template.metadata.labels, //sometimes work
        labels: frontendLabels,
        // labels: {
        //     // ...frontendDeployment.metadata.labels,
        //     app: "frontend",
        // },
        name: "frontend",
    },
    spec: {
        type: isMinikube ? "ClusterIP" : "LoadBalancer",
        // type: isMinikube ? "ClusterIP" : "ClusterIP",
        // ports: [{ port: 80 }],
        // ports: [
        //     {
        //         name: "http",
        //         port: 80,
        //         // targetPort: 80,
        //         // targetPort: 3000,
        //     },

        //     {
        //         // name: "fe-metrics" must match port: "fe-metrics"(L119) in the frontEndServiceMonitor. Prometheus uses the Service port name, not the numeric port.
        //         // //  "frontend": must be no more than 15 characters so changed to fe-metrics
        //         name: "fe-metrics",
        //         // port: 9090,
        //         // targetPort: 9090,
        //         port: 9113,
        //         targetPort: 9113,
        //     },
        // ],
        //fixess
        ports: [
            {
                name: "http",
                port: 80,
                targetPort: 80,
            },
            {
                name: "fe-metrics",
                port: 9113,
                targetPort: 9113,
            },
        ],
        selector: frontendDeployment.spec.template.metadata.labels, //sometimes work
    },
});

// onfigure Prometheus to scrape metrics from the Guestbook frontend and backend services (e.g., using basic Kubernetes ServiceMonitor resources or annotations).
//Create a ServiceMonitor; kube-prometheus-stack uses custom resources.
// This tells Prometheus what to scrape.
const frontEndServiceMonitor = new k8s.apiextensions.CustomResource("frontend-monitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",

    metadata: {
        name: "frontend-monitor",
        namespace: monitoringNamespace.metadata.name,
        // namespace: "monitoring",
        // Without this label, Prometheus may ignore the ServiceMonitor depending on Helm values.
        labels: {
            release: "kube-prometheus-stack",
        },
    },

    spec: {
        selector: {
            matchLabels: {
                app: "frontend",
            },
        },

        endpoints: [
            {
                port: "fe-metrics",
                path: "/metrics",
                interval: "10s",
            },
        ],

        // namespaceSelector: {
        //     any: true,
        // },
        namespaceSelector: {
            matchNames: ["default"],
        },
    },
});

// new
// const frontendLabels = { app: "frontend" };

// const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
//     metadata: {
//         namespace: "default",
//     },
//     spec: {
//         replicas: 3,
//         selector: {
//             matchLabels: frontendLabels,
//         },
//         template: {
//             metadata: {
//                 labels: frontendLabels,
//             },
//             spec: {
//                 containers: [
//                     {
//                         name: "frontend",
//                         image: "pulumi/guestbook-php-redis",
//                         resources: {
//                             requests: {
//                                 cpu: "100m",
//                                 memory: "100Mi",
//                             },
//                         },
//                         env: [
//                             {
//                                 name: "GET_HOSTS_FROM",
//                                 value: "dns",
//                             },
//                         ],
//                         ports: [
//                             {
//                                 containerPort: 80,
//                                 name: "http",
//                             },
//                         ],
//                     },
//                 ],
//             },
//         },
//     },
// });

// const frontendService = new k8s.core.v1.Service("frontend", {
//     metadata: {
//         namespace: "default",
//         labels: frontendLabels,
//         name: "frontend",
//     },
//     spec: {
//         type: "ClusterIP",
//         selector: frontendLabels,
//         ports: [
//             {
//                 name: "http",
//                 port: 80,
//                 targetPort: "http",
//             },
//         ],
//     },
// });

// const frontEndServiceMonitor =
//     new k8s.apiextensions.CustomResource("frontend-monitor", {
//         apiVersion: "monitoring.coreos.com/v1",
//         kind: "ServiceMonitor",
//         metadata: {
//             name: "frontend-monitor",
//             namespace: "monitoring",
//             labels: {
//                 release: "kube-prometheus-stack",
//             },
//         },
//         spec: {
//             selector: {
//                 matchLabels: frontendLabels,
//             },
//             namespaceSelector: {
//                 matchNames: ["default"],
//             },
//             endpoints: [
//                 {
//                     port: "http",
//                     path: "/",
//                     interval: "30s",
//                 },
//             ],
//         },
//     });

// Export the frontend IP.
// export let frontendIp: pulumi.Output<string>;
// if (isMinikube) {
//     frontendIp = frontendService.spec.clusterIP;
// } else {
//     frontendIp = frontendService.status.loadBalancer.ingress[0].ip;
// }
//fixess
export const frontendIp = pulumi.all([
    frontendService.status.loadBalancer.ingress,
    frontendService.spec.clusterIP,
]).apply(([ingress, clusterIP]) => {
    if (isMinikube) return clusterIP ?? "http://localhost";
    return ingress?.[0]?.ip || ingress?.[0]?.hostname || "pending";
});