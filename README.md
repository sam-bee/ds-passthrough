# DeepSeek passthrough

**Retired on 24 October 2026.** The service has been removed from k3s, including its workload, ingress, HTTPS certificate, Kubernetes credentials, and dedicated Flux configuration. Local copies of the proxy token and DeepSeek key have also been removed. Pushing to `main` no longer deploys the service.

The code and deployment manifests are retained for reference. The instructions below describe the previous deployment and can be reused if the service is needed again.

Former endpoint: **https://ds.personalinfra.co.uk**

Replace `https://api.deepseek.com` with that URL and use the **proxy token** as the client API key. The server replaces it with the operator's DeepSeek API key. Your colleague never needs the real DeepSeek key.

## Browser usage

```javascript
const response = await fetch('https://ds.personalinfra.co.uk/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${proxyToken}`,
  },
  body: JSON.stringify({
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'Hello!' }],
    stream: false,
  }),
});
if (!response.ok) throw new Error(await response.text());
console.log(await response.json());
```

CORS permits all origins, including `file://` pages (`Origin: null`) and localhost. Use `credentials: 'omit'` (the fetch default for cross-origin calls); cookie authentication is not supported. `X-API-Key: <proxy token>` also works. Anyone with the proxy token can spend the operator's DeepSeek balance: share it only with the intended colleague.

Supported endpoints:

- `POST /chat/completions` and `/v1/chat/completions`
- `POST /responses` and `/v1/responses`
- `GET /models` and `/v1/models`

Request JSON, query strings, upstream status codes and error bodies pass through. `stream: true` streams SSE without buffering. The `/v1` prefix is preserved. The proxy does not rewrite model names: use `GET /models` to discover available models. See [DeepSeek's API documentation](https://api-docs.deepseek.com/).

Only these routes can access the fixed DeepSeek upstream. Incoming cookies and authorization are not forwarded. Prompts, response bodies, API keys and tokens are not logged. Limits: 8 concurrent upstream requests, 8 MiB request bodies, 30 seconds to upload a request and 10 minutes for a complete upstream response. Busy requests return 429 with `Retry-After: 10`. This concurrency limit is not a daily spending cap. There are no automatic retries of paid requests.

## Credentials

The Kubernetes Secret `ds-passthrough/ds-passthrough` has two keys:

- `DEEPSEEK_API_KEY`: the operator's upstream key
- `PROXY_TOKEN`: the shared token used by the colleague

Create or update it from a hidden prompt:

```sh
export KUBECONFIG="$HOME/.kube/containernode.yaml"
python3 scripts/configure-secret.py
```

Or load a key file, without displaying its contents:

```sh
python3 scripts/configure-secret.py --key-file "$HOME/.config/ds-passthrough/deepseek-api-key"
```

The script generates a proxy token on first use, preserves it when changing the DeepSeek key, and saves it in `~/.config/ds-passthrough/proxy-token` with mode 0600. The input key file is also set to 0600. Neither credential belongs in this repository. Add `--rotate-token` to the helper command to generate a new colleague token. Existing in-flight requests retain their original credentials.

Credentials are mounted as files and reread for each request. Kubernetes Secret changes usually reach the pod within two minutes, without a restart. `/healthz` checks process health; `/readyz` checks that both credentials are present. These checks do not verify upstream account balance or key validity.

## Deployment on k3s

DNS: `A ds.personalinfra.co.uk -> 51.75.167.127` (the public Traefik address).

The manifests use the existing `traefik` ingress class and `letsencrypt-production-dns01-cloudflare` ClusterIssuer. cert-manager provisions and renews the HTTPS certificate. HTTP is not routed to the API; configure clients with the HTTPS URL.

The service has no npm dependencies or build step. Kustomize packages `server.mjs` in a content-hashed ConfigMap; a source change changes the Deployment and rolls the pod automatically. The runtime is an official Node 24 Alpine image pinned by digest. The container runs as an unprivileged user with a read-only filesystem and no Kubernetes API token. The Secret is managed separately and is never reconciled from Git.

Bootstrap once, after configuring credentials and pushing `main`:

```sh
kubectl apply -f deploy/flux.yaml
kubectl -n flux-system wait gitrepository/ds-passthrough --for=condition=Ready --timeout=120s
kubectl -n flux-system wait kustomization/ds-passthrough --for=condition=Ready --timeout=180s
```

Flux then reconciles this repository's `main` branch every minute, independently of the other cluster applications. The source uses public read-only HTTPS; if the repository becomes private, configure a dedicated source credential. All application and bootstrap manifests live in this repository.

For a manual deployment without Flux:

```sh
kubectl apply -k .
kubectl -n ds-passthrough rollout status deployment/ds-passthrough --timeout=180s
```

After enabling Flux, deploy changes by pushing to `main`; revert a commit on `main` to roll back. Flux pruning retains the namespace and its separately managed credentials, even when removing the application.

## Verification and development

```sh
npm test
kubectl kustomize . >/dev/null
python3 scripts/smoke-test.py
```

The integration tests use a local mock upstream to check authentication, key substitution, CORS, streamed chunks before completion, cancellation, concurrency, request limits, credential rotation, errors and timeouts. The public smoke test validates HTTPS and makes two tiny real DeepSeek requests, one JSON and one streaming. `/responses` is forwarded but not exercised by that smoke test.

For local development on Node 24+, set `DEEPSEEK_API_KEY` and `PROXY_TOKEN` in the environment, or supply their `_FILE` equivalents, then run `npm start`. File-backed credentials take precedence. The default port is 8080 (`PORT` overrides it).
