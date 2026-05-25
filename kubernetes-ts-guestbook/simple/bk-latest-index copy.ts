// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Minikube does not implement services of type `LoadBalancer`; require the user to specify if we're
// running on minikube, and if so, create only services of type ClusterIP.
const config = new pulumi.Config();
// const isMinikube = config.getBoolean("isMinikube");
// set a default of false if isMinikube is not true
const isMinikube = config.getBoolean("isMinikube") || false;

// Debug: You will see in the output of the pulumi up command in the terminal
console.log("isMinikube =", isMinikube);


//
// Deploy Prometheus and Grafana.
//

//Create Monitoring Namespace for Prometheus and Grafana
const monitoringNamespace = new k8s.core.v1.Namespace("monitoring", {
    metadata: {
        name: "monitoring",
    },
});

// Deploy Prometheus and Grafana via helm chart - kube-prometheus-stack
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

            // Expose Grafana as a LoadBalancer or NodePort service - Using NodePort as using LB with minikube requires tunnelling
            service: {
                type: "NodePort",
                nodePort: 32000
            },
        },

        // alertmanager: {
        //     enabled: false,
        // },

        prometheus: {
            prometheusSpec: {
                // FEserviceMonitorSelectorNilUsesHelmValues: false,
                serviceMonitorSelectorNilUsesHelmValues: false,
                // serviceMonitorSelector: {},
                // serviceMonitorNamespaceSelectoe: {},
            },
        },
    },

});
// }, {// Wait for up to 15 minutes for all resources in the chart to become available
//     customTimeouts: { create: "15m", update: "15m" }
//     });


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
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.58.0",
                        resources: { requests: { cpu: "50m", memory: "64Mi" } },
                        ports: [{ name: "metrics", containerPort: 9121 }],
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
        ports: [
            { name: "redis", port: 6379, targetPort: 6379 },
            { name: "metrics", port: 9121, targetPort: 9121 }
        ],
        // selector: redisLeaderDeployment.spec.template.metadata.labels,
        selector: redisLeaderLabels,
    },
});

// Add ServiceMonitor for redis leader
const redisLeaderServiceMonitor = new k8s.apiextensions.CustomResource("redis-leader-sm", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "redis-leader-sm",
        namespace: "monitoring",
        // namespace: monitoringNamespace.metadata.name,
        labels: { release: "kube-prometheus-stack" },
    },
    spec: {
        selector: { matchLabels: { app: "redis-leader", } },
        namespaceSelector: { any: true },
        // namespaceSelector: { matchNames: ["default"] },
        endpoints: [
            {
                port: "metrics",
                path: "/metrics",
                interval: "10s",
            },
        ],
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
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.58.0",
                        resources: { requests: { cpu: "50m", memory: "64Mi" } },
                        ports: [{ name: "metrics", containerPort: 9121 }],
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
        // ports: [{ port: 6379, targetPort: 6379 }],
        ports: [
            { name: "redis", port: 6379, targetPort: 6379 },
            { name: "metrics", port: 9121, targetPort: 9121 }
        ],
        // selector: redisReplicaDeployment.spec.template.metadata.labels,
        selector: redisReplicaLabels,
    },
});

// Add ServiceMonitor for redis replica
const redisReplicaServiceMonitor = new k8s.apiextensions.CustomResource("redis-replica-sm", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "redis-replica-sm",
        namespace: "monitoring",
        // namespace: monitoringNamespace.metadata.name,
        labels: { release: "kube-prometheus-stack" },
    },
    spec: {
        selector: { matchLabels: { app: "redis-replica", } },
        namespaceSelector: { any: true },
        // namespaceSelector: { matchNames: ["default"] },
        endpoints: [
            {
                port: "metrics",
                path: "/metrics",
                interval: "10s",
            },
        ],
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
                        ports: [{ name: "http", containerPort: 80 }],
                    },
                    //  // Expose Guestbook Metrics by adding a Sidecar Exporter
                    // {
                    //     name: "nginx-exporter",
                    //     image: "nginx/nginx-prometheus-exporter:1.1.0",
                    //     args: [
                    //         "-nginx.scrape-uri=http://localhost:80/status",
                    //     ],
                    //     ports: [
                    //         {
                    //             name: "metrics",
                    //             containerPort: 9113,
                    //         },
                    //     ],
                    // },
                ],
            },
        },
    },
});
const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        // labels: frontendDeployment.metadata.labels,
        name: "frontend",
        // You should explicitly set labels on the Service.
        labels: frontendLabels,
    },
    spec: {
        type: isMinikube ? "ClusterIP" : "LoadBalancer",
        // ports: [{ port: 80 }],
        // name: "fe-metrics" must match port: "fe-metrics"(L283) in the frontEndServiceMonitor. Prometheus uses the Service port name, not the numeric port.
        //  frontend": must be no more than 15 characters so changed to fe-metrics
        // ports: [{ name: "http", port: 80, targetPort: 80 }, { name: "metrics", port: 9113, targetPort: 9113 }],
        ports: [{ name: "http", port: 80, targetPort: 80 }],
        // selector: frontendDeployment.spec.template.metadata.labels,
        selector: frontendLabels,
    },
});


// Add ServiceMonitor for frontend. This tells Prometheus what to scrape.
const frontEndServiceMonitor = new k8s.apiextensions.CustomResource("frontend-sm", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "frontend-sm",
        // namespace: monitoringNamespace.metadata.name,
        namespace: "monitoring",
        // Without this label, Prometheus may ignore the ServiceMonitor depending on Helm values.
        labels: { release: "kube-prometheus-stack" },
    },
    spec: {
        selector: { matchLabels: { app: "frontend" } },
        // namespaceSelector: { matchNames: ["default"]},
        endpoints: [
            {
                port: "http",
                path: "/metrics",
                interval: "10s",
            },
        ],
    },
});


// // =============================================================================
// // PROMETHEUS SERVICE (reference from Helm release)
// // =============================================================================

// const prometheusService = k8s.core.v1.Service.get("prometheus-svc",
//     pulumi.interpolate`${monitoringNamespace.metadata.name}/kube-prometheus-stack-prometheus`,
//     { dependsOn: [monitoring] },
// );

// =============================================================================
// GRAFANA
// =============================================================================

const grafanaDatasourceConfig = new k8s.core.v1.ConfigMap("grafana-datasources", {
    metadata: {
        name: "grafana-datasources",
        namespace: monitoringNamespace.metadata.name,
    },
    data: {
        "datasources.yaml": `
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://kube-prometheus-stack-758d-prometheus.monitoring:9090/
    isDefault: true
    editable: true
`,
    },
});

const grafanaDashboardConfig = new k8s.core.v1.ConfigMap("grafana-dashboards-config", {
    metadata: {
        name: "grafana-dashboards-config",
        namespace: monitoringNamespace.metadata.name,
    },
    data: {
        "dashboards.yaml": `
apiVersion: 1
providers:
  - name: 'default'
    orgId: 1
    folder: ''
    type: file
    disableDeletion: false
    editable: true
    options:
      path: /var/lib/grafana/dashboards
      foldersFromFilesStructure: false
`,
    },
});

const grafanaDashboardJson = new k8s.core.v1.ConfigMap("grafana-dashboard-guestbook", {
    metadata: {
        name: "grafana-dashboard-guestbook",
        namespace: monitoringNamespace.metadata.name,
    },
    data: {
        "guestbook.json": JSON.stringify({
            annotations: { list: [] },
            editable: true,
            fiscalYearStartMonth: 0,
            graphTooltip: 0,
            id: null,
            links: [],
            panels: [
                {
                    title: "Container CPU Usage (frontend)",
                    type: "timeseries",
                    datasource: "Prometheus",
                    gridPos: { h: 8, w: 12, x: 0, y: 0 },
                    targets: [
                        {
                            expr: 'rate(container_cpu_usage_seconds_total{pod=~"frontend.*"}[5m])',
                            legendFormat: "{{pod}}",
                        },
                    ],
                },
                {
                    title: "Container Memory Usage (frontend)",
                    type: "timeseries",
                    datasource: "Prometheus",
                    gridPos: { h: 8, w: 12, x: 12, y: 0 },
                    targets: [
                        {
                            expr: 'container_memory_usage_bytes{pod=~"frontend.*"}',
                            legendFormat: "{{pod}}",
                        },
                    ],
                },
                {
                    title: "Container CPU Usage (redis)",
                    type: "timeseries",
                    datasource: "Prometheus",
                    gridPos: { h: 8, w: 12, x: 0, y: 8 },
                    targets: [
                        {
                            expr: 'rate(container_cpu_usage_seconds_total{pod=~"redis.*"}[5m])',
                            legendFormat: "{{pod}}",
                        },
                    ],
                },
                {
                    title: "Container Memory Usage (redis)",
                    type: "timeseries",
                    datasource: "Prometheus",
                    gridPos: { h: 8, w: 12, x: 12, y: 8 },
                    targets: [
                        {
                            expr: 'container_memory_usage_bytes{pod=~"redis.*"}',
                            legendFormat: "{{pod}}",
                        },
                    ],
                },
            ],
            schemaVersion: 38,
            tags: ["guestbook"],
            templating: { list: [] },
            time: { from: "now-1h", to: "now" },
            title: "Guestbook Application",
            uid: "guestbook-dashboard",
        }),
    },
});

// Export the frontend IP.
// export let frontendIp: pulumi.Output<string>;
// if (isMinikube) {
//     frontendIp = frontendService.spec.clusterIP;
// } else {
//     frontendIp = frontendService.status.loadBalancer.ingress[0].ip;
// }
// Fancy way - Not sure I should do this yet
// export const frontendIp = pulumi.all([
//     frontendService.status.loadBalancer.ingress,
//     frontendService.spec.clusterIP,
// ]).apply(([ingress, clusterIP]) => {
//     if (isMinikube) return clusterIP ?? "http://localhost";
//     return ingress?.[0]?.ip || ingress?.[0]?.hostname || "pending";
// });

// Export Grafana URL
// Output Grafana Access Details:
// Use Pulumi to output the Grafana access URL and default admin credentials.

// export const grafanaUrl =
//     monitoring.status.namespace.apply(ns =>
//         `http://localhost:3000`
//     );

export let grafanaUrl: pulumi.Output<string>;
if (isMinikube) {
    grafanaUrl = pulumi.interpolate`http://localhost:3000`;
}
// else {
//     grafanaUrl = grafanaService.status.loadBalancer.ingress[0].ip.apply(
//         (ip: string) => `http://${ip}:3000`,
//     );
// }

export const grafanaAdminUser = "admin";
export const grafanaAdminPassword = "admin123";
export const prometheusUrl = "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090";

// Notes
// Access Grafana (If not using NodePort with Minikube):
//  kubectl port-forward svc/kube-prometheus-stack-758d46a1-grafana -n monitoring 3000:80
// Then open: http://localhost:3000

// Default Grafana Credentials
// username: admin
// password: admin123

// Access Prometheus
// kubectl port-forward svc/kube-prometheus-stack-758d-prometheus -n monitoring 9090
// Then Open: http://localhost:9090
