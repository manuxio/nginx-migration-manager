# Kubernetes deployment

A single Pod with two containers (**nginx** + **app**) sharing one volume — the same shape as
the docker-compose stack. Because containers in a Pod share volumes, the file-based IPC and the
polling watcher work unchanged. Static config comes from a **ConfigMap**; the dynamic per-host
`.conf` files + git history live on a **PVC**.

```
configmap.yaml   base nginx.conf + shared proxy.conf snippet (subPath-mounted, read-only)
secret.example.yaml  basic-auth user/pass  (copy to secret.yaml)
pvc.yaml         1Gi RWO volume: subPath "sites" (configs+git) and "appdata" (manifest/backups)
deployment.yaml  1 replica, Recreate, the two containers
service.yaml     proxy (LoadBalancer :80) + admin (ClusterIP :3000, internal)
gke-gcs/         GKE variant that stores state in a GCS bucket instead of a PVC
```

## Deploy

```bash
kubectl create namespace nginx-managed
kubectl -n nginx-managed apply -f configmap.yaml -f pvc.yaml -f service.yaml

# credentials (don't commit a real secret):
kubectl -n nginx-managed create secret generic nginx-managed-auth \
  --from-literal=user=admin --from-literal=pass='a-strong-password'

kubectl -n nginx-managed apply -f deployment.yaml
```

- **Admin UI** (keep it off the internet): `kubectl -n nginx-managed port-forward svc/nginx-managed-admin 3000:3000` → <http://localhost:3000>
- **Proxy**: the `nginx-managed-proxy` LoadBalancer's external IP on port 80.

Pin the images to a digest/tag in prod (e.g. `…/app:sha-5e84bf0`) instead of `:latest`.

## Important: this is single-replica by design

The app is the **single writer** of one shared, persistent state (the git repo + `.conf`
files). **Do not bump `replicas`** — multiple app instances writing/`git commit`-ing to the
same files will race. The Pod is `Recreate` + RWO PVC; rely on the scheduler to reschedule it on
failure. For real HA you'd split it (one writer pod + N read-only nginx pods on RWX storage) —
that's a refactor, not a config change.

## What's already k8s-friendly
- **No Docker socket** and no privileged access — the app only reads/writes files.
- The **polling watcher** works on any volume backend (it never needed inotify).
- **Seed-on-first-boot** still works if you mount the whole `/etc/nginx` from a volume instead
  of using the ConfigMap; with the ConfigMap variant here, `nginx.conf` is simply always present
  so the seed is a no-op.

## Notes
- ConfigMap is mounted via `subPath`, so editing it needs `kubectl rollout restart deploy/nginx-managed`.
- The app probe is a `tcpSocket` (every HTTP route is behind basic auth, so an httpGet probe
  would get 401). Add an unauthenticated `/healthz` to the app if you want a real HTTP probe.
- If your cluster enforces a restricted Pod Security Standard, nginx running as root to bind :80
  may be blocked — run nginx on a high port + `NET_BIND_SERVICE`, or front it with an Ingress.

For storing state in a **GCS bucket** instead of a PVC, see [gke-gcs/README.md](gke-gcs/README.md).
