# GKE: store state in a GCS bucket

This variant mounts a **GCS bucket** (instead of a PVC) at `/etc/nginx/sites` and `/data`, using
the **Cloud Storage FUSE CSI driver**. It reuses `configmap.yaml`, `secret.yaml`, and
`service.yaml` from the parent `k8s/` folder; only the Deployment + ServiceAccount change.

> Read the **Caveats** at the bottom first — object storage is not a real POSIX filesystem, and
> this app runs a **git repo** on it. For a low-write migration-control panel it's usually fine,
> but know the trade-offs.

## 1. Cluster + bucket

```bash
PROJECT_ID=your-project
CLUSTER=your-cluster
REGION=europe-west1
BUCKET=gs://${PROJECT_ID}-nginx-managed      # globally-unique name

# enable the GCS FUSE CSI driver + Workload Identity on the cluster
gcloud container clusters update "$CLUSTER" --region "$REGION" \
  --update-addons GcsFuseCsiDriver=ENABLED
gcloud container clusters update "$CLUSTER" --region "$REGION" \
  --workload-pool="${PROJECT_ID}.svc.id.goog"

# the bucket (uniform access; same region as the cluster for latency)
gcloud storage buckets create "$BUCKET" --location "$REGION" --uniform-bucket-level-access
```

## 2. Workload Identity → bucket access

```bash
NS=nginx-managed
GSA=nginx-managed@${PROJECT_ID}.iam.gserviceaccount.com

gcloud iam service-accounts create nginx-managed --project "$PROJECT_ID"

# grant access to THIS bucket only (objectAdmin: read/write/delete objects)
gcloud storage buckets add-iam-policy-binding "$BUCKET" \
  --member="serviceAccount:${GSA}" --role=roles/storage.objectAdmin

# let the k8s SA (k8s/gke-gcs/serviceaccount.yaml) impersonate the GSA
gcloud iam service-accounts add-iam-policy-binding "$GSA" \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:${PROJECT_ID}.svc.id.goog[${NS}/nginx-managed]"
```

## 3. Deploy

Edit `serviceaccount.yaml` (replace `PROJECT_ID`) and `deployment.yaml` (replace
`YOUR_BUCKET_NAME` — the name **without** the `gs://` prefix). Then:

```bash
kubectl create namespace "$NS"
kubectl -n "$NS" apply -f ../configmap.yaml -f ../service.yaml
kubectl -n "$NS" create secret generic nginx-managed-auth \
  --from-literal=user=admin --from-literal=pass='a-strong-password'
kubectl -n "$NS" apply -f serviceaccount.yaml -f deployment.yaml
```

On first boot the bucket is empty; the app `git init`s `sites/` and writes there, exactly like an
empty volume. Your config + history are now durable in GCS and survive the Pod entirely.

## Caveats (please read)

GCS FUSE presents object storage as a filesystem, so:

- **git runs, but slower.** Each git object is a separate GCS object PUT, so a commit is a few
  network round-trips. Fine for occasional changes (this is a control panel, not a hot path).
  Because it's a **single writer** (1 replica), git lock races don't occur.
- **Cross-container freshness.** The nginx watcher (one container) polls files the app (another
  container) writes. gcsfuse caches metadata; the `mountOptions` here set **low cache TTLs**
  (`metadata-cache:ttl-secs:1`, `type-cache:ttl-secs:1`) so the watcher sees writes within ~1s.
  Raise them for speed if you don't care about a few seconds of lag.
- **`rename` isn't atomic** on gcsfuse (it's copy+delete). The app writes via tmp+rename; at this
  write rate that's a non-issue, but don't expect POSIX atomicity guarantees.
- **No inotify** — irrelevant here, because the watcher polls.

If you ever see git slowness/corruption, the robust pattern is: keep the **live** `sites/` on a
small Persistent Disk (PVC, as in the parent folder) and use the bucket only for **backup/export**
(a CronJob or sidecar running `gcloud storage rsync`). You get POSIX semantics for git plus durable
object storage — at the cost of the bucket not being the live store.
