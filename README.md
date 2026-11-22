# tooling.cognitio.it

This repository deploys the tooling install: the Cloudflare resources and Workers that serve the Cognitio tooling
and the TANDEM marketplace.

## What it deploys

| Host | Worker | Serves |
|---|---|---|
| `tooling.cognitio.it` | `cognitio-tooling` | the tooling's public surface |
| `tooling-admin.cognitio.it` | `cognitio-tooling-admin` | the administration surface, behind Cloudflare Access |
| `tooling.aggrega.ai` | `tandem-tooling-registry` | the TANDEM registry |
| `tooling.aggrega.ai` | `tandem-tooling-files` | the TANDEM marketplace files |

The Workers share one R2 bucket, `tandem-tooling`. OpenTofu (`iac/`) owns the bucket, the D1 database, the
generated keys, the DNS records, the routes, the custom domain and the Access application; `wrangler deploy` owns
each Worker's code, variables and bindings.

## Pins

The submodules carry the code that is deployed:

- `cognitio-tooling` is pinned at a release tag `vX.Y.Z` on its `main` branch.
- `serverless-registry` is pinned at a commit of its `aggrega` branch.

`scripts/check-pins.sh` refuses a deploy whose pins break either rule, or whose checkouts are not at the commits the
gitlinks name; the deploy runs it before the tests and again before the D1 migrations and the Worker deploys.

An upgrade is one commit that moves one gitlink: to a newer release tag for `cognitio-tooling`, to a newer `aggrega`
commit for `serverless-registry`. Pushing that commit deploys it.

## Operator steps

### Repository settings

Repository variables:

| Variable | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | the account that owns the Workers and the zones |
| `CLOUDFLARE_ZONE_IDS` | JSON object, hostname to zone ID, one entry for each host in the table above |
| `TOFU_STATE_BUCKET` | the R2 bucket holding OpenTofu's encrypted state |
| `ACCESS_IDP_ID` | the ID of the Access identity provider the admin host signs in with |
| `ADMIN_SERVICE_TOKEN_ID` | the ID of the Access service token the command line presents (the ID, never the secret) |
| `ACCESS_TEAM_DOMAIN` | the Access team domain, an `https` origin with no path |

Repository secrets:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | account permissions Workers Scripts, Workers R2 Storage, D1 and Access Apps and Policies, all Edit; zone permissions Workers Routes and DNS, Edit |
| `TOFU_STATE_PASSPHRASE` | the state's encryption passphrase; keep it in the password manager too, since without it the state cannot be read |
| `ACCESS_ALLOWED_EMAILS` | the addresses allowed through the admin host's Access gate, comma-separated |
| `COGNITIO_TOOLING_DEPLOY_KEY` | a read-only deploy key on `cognitiosrl/cognitio-tooling` |

GitHub does not send secrets to workflows run for pull requests from forks (repository and organisation settings).
`plan.yml` skips the checkout of `cognitio-tooling` and every step that needs it for such a pull request and for one by
Dependabot; the tests that need no checkout still run.

### Deploying code and infrastructure

A push to `main` runs `deploy.yml`: the pin check (`scripts/check-pins.sh`), the tests, OpenTofu, the D1 migrations and
the Workers, then a check of each deployment and a smoke test of the public hosts. A push deploys code and applies
an OpenTofu plan only when it changes nothing or only adds outputs: `scripts/tofu.sh apply` refuses any other resource
change, and any change to or removal of an existing output, without `--confirmed`, and a delete, replace or forget of a
resource, or a change to a sensitive output (a key the deploy ships), without `--delete-confirmed` as well. The refusal
fails the run before any Worker deploys.

To change infrastructure:

1. Open a pull request: `plan.yml` shows OpenTofu's plan and applies nothing.
2. Merge it; the push stops at OpenTofu if the plan changes infrastructure.
3. Run the `deploy` workflow with `workflow_dispatch` and `plan_only` set: it runs `scripts/tofu.sh plan` and stops.
   Read the plan.
4. Run the workflow again with `infra_change_confirmed` set, and also `delete_confirmed` when the plan deletes,
   replaces or forgets a resource or changes a sensitive output.

One deploy runs at a time (`concurrency` group `deploy-<repository>`, `cancel-in-progress` false). A run that is still waiting in the group is
cancelled when a newer one queues (GitHub's rule), so a confirmed dispatch can be superseded by a push that arrives
meanwhile; the run that was running is never cancelled, and a superseded dispatch does nothing: dispatch it again.

Each deploy prints the D1 database's Time Travel bookmark in its job summary before it applies the migrations.

### Deploy guard

A Worker that holds secrets the workflow does not upload (the registry's pairs, the files Worker's `CONSUMERS`) keeps
them from its previous version across a deploy. Before the registry and files deploys, the workflow reads the Worker's
deployment and its versions and deploys only while its latest version serves at 100 %; otherwise the step fails and its
message names the way out: put each kept secret on a new version with `wrangler versions secret put <NAME> --name
<worker>` and deploy that version with `wrangler versions deploy <version>@100% --name <worker>`, or, if the latest
version's secrets are right, `wrangler versions deploy <latest>@100% --name <worker>`. The guard needs an existing
deployment, so the registry's and the files Worker's first deploy is made by hand.

Both ways out serve the latest version's code: `wrangler versions secret put` patches the latest version, and
`wrangler versions deploy <latest>` serves it. After rolling back a faulty registry or files version, resuming the
guard's way out therefore serves the faulty code again until the next deploy. Deploy the fixed code, or upload a new
version from the good one (`wrangler versions upload` from its source) and put the kept secrets on that.

### Upgrading

An upgrade is one commit that moves one gitlink (see Pins):

```bash
git -C cognitio-tooling fetch --tags origin && git -C cognitio-tooling checkout vX.Y.Z
git add cognitio-tooling && git commit -m "chore: move cognitio-tooling to X.Y.Z"

git -C serverless-registry fetch origin aggrega && git -C serverless-registry checkout <commit on aggrega>
git add serverless-registry && git commit -m "chore: move serverless-registry"
```

`scripts/check-pins.sh` refuses a commit that moves `cognitio-tooling` to anything but a release tag `vX.Y.Z` on its
`main`, or `serverless-registry` to a commit that is not on `aggrega`. A `cognitio-tooling` release's D1 migrations are
applied by the deploy before the Workers.

### Moving a host's reads to another Worker

The Worker that serves a host's reads is set by `any_publication_worker_name` in `iac/variables.tf`. Change it in one
commit; the push stops at OpenTofu, because the route changes. Run `plan_only` and check that the plan updates the
route in place; a plan that replaces it is refused by `scripts/tofu.sh apply` unless `delete_confirmed` is also set, so
do not set it. Then run the confirmed dispatch. To move the reads back, revert the commit and run the confirmed dispatch
again.

### Rolling back

- A Worker: `wrangler rollback <version> --name <worker>`. The rolled-back version serves at 100 % while it is not the
  latest, so the deploy guard refuses the next registry or files deploy until the latest version serves again (the
  guard's message names the ways out).
- Code: revert the commit and push.
- Infrastructure: revert the commit, then run the confirmed dispatch as above.
- D1: `wrangler d1 time-travel restore cognitio-tooling --bookmark=<bookmark from the run's job summary>`.

### Running OpenTofu by hand

`scripts/tofu.sh plan` and `scripts/tofu.sh apply` run from the same environment variables as the workflow
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TOFU_STATE_BUCKET`, `TOFU_STATE_PASSPHRASE`, `CLOUDFLARE_ZONE_IDS`,
`ACCESS_IDP_ID`, `ACCESS_ALLOWED_EMAILS`, `ADMIN_SERVICE_TOKEN_ID`) and `apply` takes the same confirmation flags
(`plan` takes none). The script drops `TF_DATA_DIR`, `TF_WORKSPACE`, `TF_ENCRYPTION`, `TF_CLI_ARGS*` and `TF_VAR_*` from
the environment, so none of them changes a run; `TF_CLI_CONFIG_FILE` and the operator's own OpenTofu CLI configuration
stay. The state lock keeps a run by hand and a workflow run apart; `plan` takes none. The exit statuses are in the
script's header comment.

`scripts/tofu.sh migrate-state <plain state file>` carries a plain state into the bucket, encrypted. It runs by hand
only (it refuses under `GITHUB_ACTIONS`), needs only `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TOFU_STATE_BUCKET` and `TOFU_STATE_PASSPHRASE`, and refuses a bucket key that already
holds a state with resources.

### Rebuilding from nothing

In an account that holds none of the resources, in this order:

1. Create the R2 bucket `tandem-tooling` by hand. The `import` block in `iac/instance.tf` adopts an existing bucket and
   never creates one, so a plan fails while the bucket is absent.
2. Deploy the registry Worker and the files Worker by hand with `wrangler deploy` from their configurations in
   `workers/` and `files/`, and put their secrets: the registry's two pairs with `wrangler secret put`, the files
   Worker's `CONSUMERS` with `node consumers.mjs push` (see the credentials below). CI never puts these secrets, the
   deploy guard needs an existing deployment, and OpenTofu attaches the registry host's custom domain only to a Worker
   that is already deployed.
3. Run the `deploy` workflow with `infra_change_confirmed` set. OpenTofu creates the D1 database, the generated keys,
   the Access application, the DNS records, the routes and the custom domain and imports the bucket; the same run then
   applies the D1 migrations and deploys the admin and serve Workers, uploading `VERIFIER_KEY` and `CSRF_KEY` (admin)
   and `VERIFIER_KEY` (serve). Neither of those two Workers needs a first deploy by hand, and the generated keys and
   the D1 database's ID reach them only through the workflow, since `scripts/tofu.sh output` refuses to run outside
   GitHub Actions.

🔴 **UNVERIFIED:** this order has not been run from an empty account; in particular, that the files Worker's routes
attach before the Worker exists is not checked, so deploy it before the first run, as above.

Credentials that `cognitio-tooling import-consumers` creates stop serving 48 hours after the import unless `--expires
<date>` says otherwise. In the import's session, give each imported consumer a later expiry
(`cognitio-tooling credential expires <login> imported <date|never>`) or a new credential (`cognitio-tooling credential
add`); otherwise every consumer answers 401 on the serving Worker's host once the 48 hours pass.

The read-only pair is an ordinary consumer of the files Worker, allowed `tandemsdd`; see below.

## TANDEM credentials and machine log-in

This section covers the credentials TANDEM consumers use against the registry and how a machine logs in with them.

No credential is in the repository or in OpenTofu state. The registry's pairs and the files Worker's `CONSUMERS` are
Worker secrets; the serving Worker's credentials are verifiers in its D1 database.

Which list governs which host: at the default route (`any_publication_worker_name` is `cognitio-tooling`),
`tooling.cognitio.it` is answered by the serving Worker, from its D1 customers and grants, and the files Worker answers
only `tooling.aggrega.ai/tandemsdd/*`. `node consumers.mjs … push` therefore changes only the files Worker. On
`tooling.cognitio.it`, a consumer is added, revoked or granted with the `cognitio-tooling` command line: `customer
add`, `customer disable` or `customer remove`, `credential add` or `credential revoke`, `grant add` or `grant remove`
(`import-consumers` creates only the logins that are missing). When `any_publication_worker_name` is null, the files
Worker answers `tooling.cognitio.it` and its list governs it (see "Moving a host's reads to another Worker").

- **The push pair**, used only by the release workflow: `USERNAME` and `PASSWORD` on the registry Worker,
  `tandem-tooling-registry`.
- **The registry's read-only pair**: `READONLY_USERNAME` and `READONLY_PASSWORD` on the registry Worker, which every
  machine building a TANDEM container logs in with. The registry has this one read pair and no per-consumer scoping.
- **The files Worker's consumers**: the secret `CONSUMERS` on the files Worker, `tandem-tooling-files`, a JSON list
  with one entry per consumer and the Worker's one secret. A request is served only when its Basic credential is a
  consumer's and that consumer lists the publication; a publication the consumer is not allowed answers 404, as a
  file that does not exist does, and nothing is read. The list governs `tooling.aggrega.ai/tandemsdd/*` and, whenever
  the files Worker answers `tooling.cognitio.it`, that host. It is kept in step with the serving Worker's customers,
  so that moving the reads back to the files Worker serves the same consumers: `cognitio-tooling import-consumers
  consumers.htpasswd --check` prints the logins whose hash differs and exits 1 when any does.

  ```json
  [
    {"name": "cognitio", "username": "cognitio", "passwordSha256": "<hex>", "publications": ["tandemsdd", "l10n"]},
    {"name": "aggrega",  "username": "aggrega",  "passwordSha256": "<hex>", "publications": ["tandemsdd", "l10n"]},
    {"name": "acme",     "username": "acme",     "passwordSha256": "<hex>", "publications": ["l10n"]},
    {"name": "<read-only user>", "username": "<read-only user>", "passwordSha256": "<hex>", "publications": ["tandemsdd"]}
  ]
  ```

  `passwordSha256` is the SHA-256 of the password, in hex, so the secret holds no password. Usernames are unique and
  carry no `:`. A consumer whose `publications` is `["*"]` is allowed every publication on any host the files Worker answers, including one
  added later, so adding a publication changes nothing for it.

  `files/consumers.mjs` keeps the list in `consumers.htpasswd`, beside this README, one consumer per line
  (`<username>:<sha256>:<publications or *>`), and puts it as the secret. The file is git-ignored and kept with the
  operator's other secrets. Run its commands from `files/`:

  ```bash
  cd files
  node consumers.mjs add aggrega '*' --generate     # prints a random password once
  node consumers.mjs add acme l10n                  # prompts for the password
  node consumers.mjs allow acme l10n,modules,modules-admin
  node consumers.mjs remove acme
  node consumers.mjs push                           # wrangler secret put CONSUMERS
  ```

  Every change is checked by the Worker's own parser, and against the publications `files/wrangler.jsonc`
  configures, whichever host serves them, before the file is written; `--help` states the rest. A change here does not
  reach `tooling.cognitio.it` at the default route: make it with the `cognitio-tooling` commands above as well.
- **The read-only pair among the files Worker's consumers**: the registry's read-only pair is an ordinary consumer in
  `consumers.htpasswd`, allowed `tandemsdd` and nothing else, added with `node consumers.mjs add <read-only user>
  tandemsdd` and the registry's read-only password typed at the prompt. The files Worker holds no `READONLY_*`
  secret; the registry keeps its own pair, which `docker login` checks. A machine set up as under "Machine log-in"
  below reads the plugin marketplace with that pair, so its entry stays in the file.

The registry's two usernames must differ: the registry looks a credential up by username and takes the first match,
which is the push pair. A new password for the read-only pair goes to each of these places, or the pair answers 401 on one
host and 200 on the other:

- the registry: `wrangler secret put READONLY_PASSWORD` on the registry Worker;
- the files Worker: `node consumers.mjs passwd <read-only user>`, then `push`;
- the pair's customer on the serving Worker, whose imported credential holds the old password's hash. The
  `cognitio-tooling` command line sets no credential to a given password (`credential reset` prints a generated
  secret, which the registry would not know), so the customer is imported again:
  `cognitio-tooling customer remove <read-only user>`, `cognitio-tooling import-consumers consumers.htpasswd`
  (it creates only the missing login), then `cognitio-tooling credential expires <read-only user> imported never`.
  Run these back to back: between the removal and the import the pair answers 401 on the serving Worker's host.

Neither registry password may contain `,` or `|`, which the devcontainer CLI's credential variable cannot carry.

**For `tandemsdd`, the read-only pair stays the practical credential.** The plugin's marketplace helper sends the first
Docker login for the host it finds — the container's own Docker config, then `~/.docker-tandem` — and `docker login`
checks a credential against the registry, which knows only its own pairs, so a container is logged in with the
registry's read-only pair. A consumer's own credential serves every other publication, read by whatever client that
package's consumers use.

The release workflow in `aggrega-ai/tandemsdd` reads these repository Actions secrets:

| Secret | Value |
|---|---|
| `TOOLING_REGISTRY_USERNAME`, `TOOLING_REGISTRY_PASSWORD` | the push pair: the registry Worker's `USERNAME`/`PASSWORD`, never the read-only pair |
| `TOOLING_R2_API_TOKEN` | a Cloudflare API token that can write R2 objects; see the scope below |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID |

It runs on the machine named by the Actions variable `AGGREGA_RUNNER`, as the Aggrega workflows do. Set it on
`aggrega-ai/tandemsdd` (or at the organization) to the self-hosted runner's label; without it the release runs on a
GitHub-hosted `ubuntu-latest`.

The repositories are private on GitHub Free, where neither tag nor branch protection is available, so any account with
write access can push a `v*` tag and start a release. What a release can publish is bounded by the credentials its
workflow holds, so scope each one as narrowly as Cloudflare allows: an R2 API token with Object Read & Write on the
bucket `tandem-tooling` alone, created under R2's API tokens, rather than an account-wide Workers R2 Storage: Edit
token, and no token shared between packages.
🔴 **UNVERIFIED:** that `wrangler r2 object put` accepts a bucket-scoped token, and that such a token can list the
bucket's objects through the REST API, which the site modules' index job does; until a release has published with one,
keep the account-wide token at hand to fall back to.

### Machine log-in

Log in twice on each machine that builds containers, with the read-only pair:

```bash
docker login tooling.aggrega.ai --username <read-only user>
docker --config ~/.docker-tandem login tooling.aggrega.ai --username <read-only user>
```

The first login is what pulls the Features when a container is built. The second writes a tooling-only login file,
which the TANDEM Template mounts read-only into the container at `~/.docker-tandem` for the plugin's marketplace. It is
mounted as a directory, so a login made after the container was created is read at once, without a rebuild. Check that
`~/.docker-tandem/config.json` holds an `auths` entry for `tooling.aggrega.ai`: a Docker client that keeps logins in an
OS credential store, such as a macOS keychain, can store it there instead, where the container cannot read it.
