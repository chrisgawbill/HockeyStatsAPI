# Deploy main through Jenkins on the API host

The existing `hockeystatsapi.service` remains responsible for running the API.
Jenkins checks out `main` and invokes a root-owned helper as `chris_dev`. The
helper fetches and verifies that exact commit, installs dependencies and tests in
a temporary checkout, then updates the live checkout and restarts the service.
The live `.env`, caches and Python virtual environment are retained. Tests do
not receive the live `.env`.

## One-time host setup

1. Commit and push all deployment changes (including `Jenkinsfile`, the three
   deployment scripts, `package.json`, README and this guide) to `main`. The live checkout must
   be clean and on `main`; don't discard local changes to achieve this.
2. On the actual server, run:

   ```bash
   cd /home/chris_dev/projects/HockeyStatsAPI
   sudo bash bin/setup-jenkins-deploy.sh
   ```

   Node, pnpm, Git, Python with venv support, curl and flock must be installed.
   The API's existing `venv/bin/python` must work. The service currently expects
   pnpm at `/home/chris_dev/.local/share/pnpm/bin/pnpm`; verify that the
   `ExecStart` and `PATH` in `systemctl cat hockeystatsapi` match the actual pnpm
   installation. Update the service if needed and run `sudo systemctl daemon-reload`.
   Both the helper and setup script include the pnpm home and its `bin`
   subdirectory on PATH.
3. Confirm `chris_dev` can run `git fetch origin main` without interaction. This
   uses the existing live checkout's SSH access, separately from Jenkins access.
4. In Jenkins, give the node running **on this server** the label
   `hockeystats-server`. It needs an available executor.
5. Create a regular **Pipeline** job named `hockeystatsapi`, choosing **Pipeline
   script from SCM**, **Git**, repository
   `https://github.com/chrisgawbill/HockeyStatsAPI.git`, branch `*/main`, script
   path `Jenkinsfile`. Select a credential with access to this repository if it
   is private; don't assume the existing credential for other repos has access.
   Restrict who can edit or run deployment jobs: the helper runs trusted `main`
   code as the API user and therefore has access to that user's production data.
6. Click **Build Now** once to load the triggers and verify the first deployment.
   Subsequent changes to `main` are detected within about three minutes.

## Optional immediate GitHub trigger

If GitHub can reach Jenkins over HTTPS, add a repository webhook with payload URL
`https://YOUR-JENKINS-HOST/github-webhook/`, content type `application/json`, and
push events. Configure webhook secret verification through the Jenkins GitHub
plugin. Check GitHub's webhook delivery result, push to `main`, and confirm a
successful Jenkins build. Polling remains a fallback and requires no public port.

## Deployment behavior and recovery

Builds run sequentially; a file lock also prevents overlapping helper runs. A
superseded commit is skipped. Failed tests leave the running service untouched.
After tests pass there is a brief outage during dependency installation and
startup. Deployment errors fail the Jenkins build and attempt to start the
service again, but do not automatically roll back code, dependencies or database
migrations. Inspect `journalctl -u hockeystatsapi.service` and the Jenkins console;
fix forward with a new commit on `main` (or revert the bad commit and push it).
Database changes may need separate recovery. Startup applies pending migrations.

After changing the deploy helper, rerun the setup script to install its updated
root-owned copy. Nothing in the repository automatically modifies sudoers.

References: [Jenkins pipeline syntax](https://www.jenkins.io/doc/book/pipeline/syntax/)
and [GitHub plugin](https://plugins.jenkins.io/github/).
