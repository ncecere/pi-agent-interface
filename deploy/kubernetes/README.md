# Deploying Pi Agent Interface on Kubernetes

`base/` is a generic [Kustomize](https://kustomize.io) base: a Deployment (two replicas, spread over nodes, a
PodDisruptionBudget), a Service, a ServiceAccount with no API token, NetworkPolicies (default deny; DNS, PostgreSQL
and https out; the ingress controller in), and a ConfigMap generated from `base/config.env`. It holds no secret
values and no namespace, so an overlay of yours supplies those.

What an overlay adds:

1. **A namespace and an image pin.** The base uses the release tag; pin the digest from the GitHub Release (verify its
   cosign signature first):

   ```yaml
   images:
     - name: ghcr.io/ncecere/pi-agent-interface
       newTag: v0.3.1
       digest: sha256:<digest>
   ```

2. **Settings**, merged into the ConfigMap: `APP_URL` (the public https origin), `PLATFORM_URL`, `OIDC_ISSUER`,
   `OIDC_CLIENT_ID`, and optionally `INITIAL_ADMIN_EMAIL`. See the README's configuration table.
3. **A Secret `pi-agent-interface-runtime`** with `DATABASE_URL` (the app's own PostgreSQL), `SESSION_SECRET` (32 or
   more characters; `openssl rand -base64 48`) and `OIDC_CLIENT_SECRET`. With `PLATFORM_AUTH=service`, also
   `PLATFORM_SERVICE_KEY`.
4. **A PostgreSQL database** (CloudNativePG, a managed service, anything). The app migrates it when a pod starts.
5. **An Ingress or Gateway API route** to Service `pi-agent-interface`, port 80, and a patch of
   `pi-agent-interface-ingress` to your ingress controller's namespace.

The OIDC redirect URI is `<APP_URL>/auth/callback`. With `PLATFORM_AUTH=connect` (the default without a service key)
the platform fetches `<APP_URL>/oauth/client-metadata.json` from the app's public address when someone connects, so
that address must be reachable from the platform and must not redirect.

```sh
kubectl kustomize deploy/kubernetes/base      # render the base
kubectl apply -k <your overlay>
```
