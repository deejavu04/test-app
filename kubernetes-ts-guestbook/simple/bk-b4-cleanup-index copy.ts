// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const isMinikube = config.getBoolean("isMinikube");

// =============================================================================
// MONITORING NAMESPACE
// =============================================================================

const monitoringNs = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" },
});

// =============================================================================
// PROMETHEUS OPERATOR (via Helm - kube-prometheus-stack)
// =============================================================================

const prometheusStack = new k8s.helm.v3.Release("kube-prometheus-stack", {
    name: "kube-prometheus-stack",
    chart: "kube-prometheus-stack",
    version: "58.2.1",
    namespace: monitoringNs.metadata.name,
    repositoryOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
    values: {
        prometheus: {
            prometheusSpec: {
                serviceMonitorSelectorNilUsesHelmValues: false,
                serviceMonitorSelector: {},
                serviceMonitorNamespaceSelector: {},
            },
        },
        grafana: {
            enabled: false, // We deploy Grafana separately below for explicit control
        },
        alertmanager: {
            enabled: false,
        },
    },
});

// =============================================================================
// REDIS LEADER
// =============================================================================

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
                        ports: [{ containerPort: 9121, name: "metrics" }],
                        resources: { requests: { cpu: "50m", memory: "64Mi" } },
                    },
                ],
            },
        },
    },
});
const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: {
        name: "redis-leader",
        labels: { app: "redis-leader" },
    },
    spec: {
        ports: [
            { port: 6379, targetPort: 6379, name: "redis" },
            { port: 9121, targetPort: 9121, name: "metrics" },
        ],
        selector: redisLeaderDeployment.spec.template.metadata.labels,
    },
});

// =============================================================================
// REDIS REPLICA
// =============================================================================

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
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 6379 }],
                    },
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.58.0",
                        ports: [{ containerPort: 9121, name: "metrics" }],
                        resources: { requests: { cpu: "50m", memory: "64Mi" } },
                    },
                ],
            },
        },
    },
});
const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: {
        name: "redis-replica",
        labels: { app: "redis-replica" },
    },
    spec: {
        ports: [
            { port: 6379, targetPort: 6379, name: "redis" },
            { port: 9121, targetPort: 9121, name: "metrics" },
        ],
        selector: redisReplicaDeployment.spec.template.metadata.labels,
    },
});

// =============================================================================
// FRONTEND
// =============================================================================

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
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 80, name: "http" }],
                    },
                    // {
                    //     name: "apache-exporter",
                    //     image: "lusotycoon/apache-exporter:v1.0.8",
                    //     resources: { requests: { cpu: "50m", memory: "32Mi" } },
                    //     args: ["--scrape_uri=http://localhost:80/server-status?auto"],
                    //     ports: [{ containerPort: 9117, name: "metrics" }],
                    // },
                ],
            },
        },
    },
});
const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        labels: { app: "frontend" },
        name: "frontend",
    },
    spec: {
        type: isMinikube ? "ClusterIP" : "LoadBalancer",
        ports: [
            { port: 80, targetPort: 80, name: "http" }
            // { port: 9117, targetPort: 9117, name: "metrics" }
        ],
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

// =============================================================================
// SERVICE MONITORS
// =============================================================================

// const frontendServiceMonitor = new k8s.apiextensions.CustomResource("frontend-service-monitor", {
//     apiVersion: "monitoring.coreos.com/v1",
//     kind: "ServiceMonitor",
//     metadata: {
//         name: "frontend-monitor",
//         namespace: monitoringNs.metadata.name,
//         labels: { release: "kube-prometheus-stack" },
//     },
//     spec: {
//         namespaceSelector: { matchNames: ["default"] },
//         selector: { matchLabels: { app: "frontend" } },
//         endpoints: [
//             {
//                 port: "http",
//                 interval: "15s",
//                 path: "/metrics",
//             },
//         ],
//     },
// }, { dependsOn: [prometheusStack] });

const redisLeaderServiceMonitor = new k8s.apiextensions.CustomResource("redis-leader-service-monitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "redis-leader-monitor",
        namespace: monitoringNs.metadata.name,
        labels: { release: "kube-prometheus-stack" },
    },
    spec: {
        namespaceSelector: { matchNames: ["default"] },
        selector: { matchLabels: { app: "redis-leader" } },
        endpoints: [
            {
                port: "metrics",
                interval: "15s",
                path: "/metrics",
            },
        ],
    },
}, { dependsOn: [prometheusStack] });

const redisReplicaServiceMonitor = new k8s.apiextensions.CustomResource("redis-replica-service-monitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "redis-replica-monitor",
        namespace: monitoringNs.metadata.name,
        labels: { release: "kube-prometheus-stack" },
    },
    spec: {
        namespaceSelector: { matchNames: ["default"] },
        selector: { matchLabels: { app: "redis-replica" } },
        endpoints: [
            {
                port: "metrics",
                interval: "15s",
                path: "/metrics",
            },
        ],
    },
}, { dependsOn: [prometheusStack] });

// =============================================================================
// BLACKBOX EXPORTER (for HTTP probe monitoring of frontend)
// =============================================================================

const blackboxExporterLabels = { app: "blackbox-exporter" };
const blackboxExporterConfig = new k8s.core.v1.ConfigMap("blackbox-exporter-config", {
    metadata: {
        name: "blackbox-exporter-config",
        namespace: monitoringNs.metadata.name,
    },
    data: {
        "blackbox.yml": `
modules:
  http_2xx:
    prober: http
    timeout: 5s
    http:
      valid_http_versions: ["HTTP/1.1", "HTTP/2.0"]
      valid_status_codes: [200]
      method: GET
      preferred_ip_protocol: "ip4"
`,
    },
});

const blackboxExporterDeployment = new k8s.apps.v1.Deployment("blackbox-exporter", {
    metadata: {
        name: "blackbox-exporter",
        namespace: monitoringNs.metadata.name,
    },
    spec: {
        selector: { matchLabels: blackboxExporterLabels },
        replicas: 1,
        template: {
            metadata: { labels: blackboxExporterLabels },
            spec: {
                containers: [
                    {
                        name: "blackbox-exporter",
                        image: "prom/blackbox-exporter:v0.25.0",
                        args: ["--config.file=/config/blackbox.yml"],
                        ports: [{ containerPort: 9115, name: "metrics" }],
                        resources: { requests: { cpu: "50m", memory: "64Mi" } },
                        volumeMounts: [
                            { name: "config", mountPath: "/config" },
                        ],
                    },
                ],
                volumes: [
                    {
                        name: "config",
                        configMap: { name: blackboxExporterConfig.metadata.name },
                    },
                ],
            },
        },
    },
});

const blackboxExporterService = new k8s.core.v1.Service("blackbox-exporter", {
    metadata: {
        name: "blackbox-exporter",
        namespace: monitoringNs.metadata.name,
        labels: { app: "blackbox-exporter" },
    },
    spec: {
        ports: [{ port: 9115, targetPort: 9115, name: "metrics" }],
        selector: blackboxExporterLabels,
    },
});

// ServiceMonitor for the blackbox-exporter itself
const blackboxServiceMonitor = new k8s.apiextensions.CustomResource("blackbox-exporter-service-monitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "blackbox-exporter-monitor",
        namespace: monitoringNs.metadata.name,
        labels: { release: "kube-prometheus-stack" },
    },
    spec: {
        namespaceSelector: { matchNames: ["monitoring"] },
        selector: { matchLabels: { app: "blackbox-exporter" } },
        endpoints: [
            {
                port: "metrics",
                interval: "15s",
                path: "/metrics",
            },
        ],
    },
}, { dependsOn: [prometheusStack] });

// Probe CRD: probes the frontend via the blackbox-exporter
const frontendProbe = new k8s.apiextensions.CustomResource("frontend-probe", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "Probe",
    metadata: {
        name: "frontend-http-probe",
        namespace: monitoringNs.metadata.name,
        labels: { release: "kube-prometheus-stack" },
    },
    spec: {
        jobName: "frontend-http-probe",
        interval: "15s",
        module: "http_2xx",
        prober: {
            url: "blackbox-exporter.monitoring.svc.cluster.local:9115",
        },
        targets: {
            staticConfig: {
                static: [
                    "http://frontend.default.svc.cluster.local:80",
                ],
            },
        },
    },
}, { dependsOn: [prometheusStack, blackboxExporterDeployment] });

// =============================================================================
// PROMETHEUS SERVICE (reference from Helm release)
// =============================================================================

// const prometheusService = k8s.core.v1.Service.get("prometheus-svc",
//     pulumi.interpolate`${monitoringNs.metadata.name}/kube-prometheus-stack-prometheus`,
//     { dependsOn: [prometheusStack] },
// );

// =============================================================================
// GRAFANA
// =============================================================================

// Dynamically resolve the Prometheus service URL from the Helm release name + namespace

// const promSvc = k8s.core.v1.Service.get("prometheus-svc",
//     pulumi.interpolate`${monitoringNs.metadata.name}/kube-prometheus-stack-prometheus`,
//     { dependsOn: [prometheusStack] },
// );
const promInternalUrl = pulumi.interpolate`http://${prometheusStack.name}-prometheus.${monitoringNs.metadata.name}:9090`;

// const grafanaDatasourceConfig = new k8s.core.v1.ConfigMap("grafana-datasources", {
//     metadata: {
//         name: "grafana-datasources",
//         namespace: monitoringNs.metadata.name,
//     },
//     data: {
//         "datasources.yaml": `
// apiVersion: 1
// datasources:
//   - name: Prometheus
//     type: prometheus
//     access: proxy
//     url: http://kube-prometheus-stack-758d-prometheus.monitoring:9090/
//     isDefault: true
//     editable: true
// `,
//     },
// });

const grafanaDatasourceConfig = new k8s.core.v1.ConfigMap("grafana-datasources", {
    metadata: {
        name: "grafana-datasources",
        namespace: monitoringNs.metadata.name,
    },
    data: {
        "datasources.yaml": pulumi.interpolate`
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: ${promInternalUrl}
    isDefault: true
    editable: true
`,
    },
});

const grafanaDashboardConfig = new k8s.core.v1.ConfigMap("grafana-dashboards-config", {
    metadata: {
        name: "grafana-dashboards-config",
        namespace: monitoringNs.metadata.name,
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
        namespace: monitoringNs.metadata.name,
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

const grafanaLabels = { app: "grafana" };
const grafanaDeployment = new k8s.apps.v1.Deployment("grafana", {
    metadata: {
        name: "grafana",
        namespace: monitoringNs.metadata.name,
    },
    spec: {
        selector: { matchLabels: grafanaLabels },
        replicas: 1,
        template: {
            metadata: { labels: grafanaLabels },
            spec: {
                containers: [
                    {
                        name: "grafana",
                        image: "grafana/grafana:10.4.0",
                        ports: [{ containerPort: 3000 }],
                        env: [
                            { name: "GF_SECURITY_ADMIN_USER", value: "admin" },
                            { name: "GF_SECURITY_ADMIN_PASSWORD", value: "admin" },
                        ],
                        volumeMounts: [
                            {
                                name: "datasources",
                                mountPath: "/etc/grafana/provisioning/datasources",
                            },
                            {
                                name: "dashboards-config",
                                mountPath: "/etc/grafana/provisioning/dashboards",
                            },
                            {
                                name: "dashboards",
                                mountPath: "/var/lib/grafana/dashboards",
                            },
                        ],
                    },
                ],
                volumes: [
                    {
                        name: "datasources",
                        configMap: { name: grafanaDatasourceConfig.metadata.name },
                    },
                    {
                        name: "dashboards-config",
                        configMap: { name: grafanaDashboardConfig.metadata.name },
                    },
                    {
                        name: "dashboards",
                        configMap: { name: grafanaDashboardJson.metadata.name },
                    },
                ],
            },
        },
    },
});

const grafanaService = new k8s.core.v1.Service("grafana", {
    metadata: {
        name: "grafana",
        namespace: monitoringNs.metadata.name,
    },
    spec: {
        type: isMinikube ? "NodePort" : "LoadBalancer",
        ports: [{ port: 3000, targetPort: 3000, nodePort: isMinikube ? 31000 : undefined }],
        selector: grafanaLabels,
    },
});

// =============================================================================
// EXPORTS
// =============================================================================

export let grafanaUrl: pulumi.Output<string>;
if (isMinikube) {
    grafanaUrl = pulumi.interpolate`http://localhost:3000`;
} else {
    grafanaUrl = grafanaService.status.loadBalancer.ingress[0].ip.apply(
        (ip: string) => `http://${ip}:3000`,
    );
}

export const grafanaAdminUser = "admin";
export const grafanaAdminPassword = "admin";
// export const prometheusUrl = "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090";
export const prometheusUrl = "http://localhost:9090"
