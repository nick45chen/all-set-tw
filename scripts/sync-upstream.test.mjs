import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getBuildInfo } from "./build-info.mjs";

const scriptPath = fileURLToPath(
  new URL("./sync-upstream.mjs", import.meta.url),
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
  });

  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }

  return result;
}

function git(cwd, ...args) {
  return run("git", args, { cwd }).stdout.trim();
}

function write(repo, relativePath, contents) {
  const target = path.join(repo, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function configureAuthor(repo) {
  git(repo, "config", "user.name", "sync-upstream-test");
  git(repo, "config", "user.email", "sync-upstream-test@example.com");
}

function commitAll(repo, message) {
  git(repo, "add", "--all");
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function initializeRepository(repo) {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--initial-branch=main");
  configureAuthor(repo);
}

function initializeBareRepository(repo) {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--bare", "--initial-branch=main");
}

function pushMain(worktree, bareRepository) {
  git(worktree, "remote", "add", "origin", bareRepository);
  git(worktree, "push", "-u", "origin", "main");
}

function cloneRepository(bareRepository, destination) {
  run("git", ["clone", bareRepository, destination]);
  configureAuthor(destination);
}

function createUpstream(root, { includeSecondCommit = true } = {}) {
  const worktree = path.join(root, "upstream-worktree");
  const bare = path.join(root, "upstream.git");
  initializeRepository(worktree);
  write(worktree, "app.txt", "version 1\n");
  write(worktree, "removed-after-v1.txt", "remove me\n");
  write(worktree, ".github/workflows/sync-upstream.yml", "name: upstream v1\n");
  write(worktree, ".github/workflows/ci.yml", "name: upstream ci\n");
  const firstCommit = commitAll(worktree, "upstream v1");
  initializeBareRepository(bare);
  pushMain(worktree, bare);

  let latestCommit = firstCommit;
  if (includeSecondCommit) {
    write(worktree, "app.txt", "version 2\n");
    write(worktree, "new-in-v2.txt", "new\n");
    rmSync(path.join(worktree, "removed-after-v1.txt"));
    latestCommit = commitAll(worktree, "upstream v2");
    git(worktree, "push", "origin", "main");
  }

  return { bare, firstCommit, latestCommit, worktree };
}

function createImportedDeployment(root, upstream, options = {}) {
  const worktree = path.join(root, "deployment-worktree");
  const bare = path.join(root, "deployment.git");
  initializeRepository(worktree);

  if (options.unknownBaseline) {
    write(worktree, "app.txt", "not an upstream version\n");
  } else {
    write(worktree, "app.txt", "version 1\n");
    write(worktree, "removed-after-v1.txt", "remove me\n");
  }
  const rootCommit = commitAll(worktree, "Cloudflare source repo import");

  write(
    worktree,
    ".github/workflows/sync-upstream.yml",
    "name: manually installed updater\n",
  );
  const beforeSync = commitAll(worktree, "install updater workflow");

  if (options.userChange) {
    write(worktree, "user-change.txt", "keep me\n");
    commitAll(worktree, "user customization");
  }

  initializeBareRepository(bare);
  pushMain(worktree, bare);
  git(worktree, "remote", "add", "test-upstream", upstream.bare);

  return { bare, beforeSync, rootCommit, worktree };
}

function runUpdater(worktree, upstreamBare) {
  return run(process.execPath, [scriptPath], {
    cwd: worktree,
    allowFailure: true,
    env: {
      ...process.env,
      SYNC_UPSTREAM_URL: upstreamBare,
    },
  });
}

function remoteBranch(worktree, branch) {
  return git(
    worktree,
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${branch}`,
  ).split("\t")[0];
}

function withTemporaryRepository(testFunction) {
  const root = mkdtempSync(path.join(tmpdir(), "taiwan-fin-hub-sync-test-"));
  try {
    testFunction(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function reviewWorkflowScript() {
  const workflow = readFileSync(
    new URL("../.github/workflows/review-upstream.yml", import.meta.url),
    "utf8",
  );
  const lines = workflow.split("\n");
  const start = lines.indexOf("        run: |");
  assert.notEqual(start, -1);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

function createReviewDeployment(root) {
  const upstream = createUpstream(root, { includeSecondCommit: false });
  write(
    upstream.worktree,
    "scripts/sync-upstream.mjs",
    readFileSync(scriptPath, "utf8"),
  );
  commitAll(upstream.worktree, "install original updater");
  git(upstream.worktree, "push", "origin", "main");
  const bare = path.join(root, "deployment.git");
  const worktree = path.join(root, "runner");
  initializeBareRepository(bare);
  git(upstream.worktree, "remote", "add", "deployment", bare);
  git(upstream.worktree, "push", "deployment", "main");
  cloneRepository(bare, worktree);
  write(worktree, ".github/workflows/sync-upstream.yml", "name: reviewed\n");
  const main = commitAll(worktree, "install reviewed updater");
  git(worktree, "push", "origin", "main");

  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "gh"),
    '#!/bin/bash\nset -eu\nprintf "%s\\n" "$*" >> "$PR_TEST_LOG"\nif [ "$1 $2" = "pr list" ]; then\n  printf "%s" "${PR_TEST_EXISTING_URL:-}"\nfi\n',
    { mode: 0o755 },
  );
  return { upstream, bare, worktree, main, bin };
}

function runReviewWorkflow(root, deployment, { existingPr = "" } = {}) {
  const runnerTemp = path.join(root, "runner-temp");
  mkdirSync(runnerTemp, { recursive: true });
  return run("bash", ["-c", reviewWorkflowScript()], {
    cwd: deployment.worktree,
    allowFailure: true,
    env: {
      ...process.env,
      PATH: `${deployment.bin}${path.delimiter}${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: path.join(runnerTemp, "outputs"),
      GITHUB_REPOSITORY: "example/deployment",
      SYNC_UPSTREAM_URL: deployment.upstream.bare,
      PR_TEST_LOG: path.join(root, "pr.log"),
      PR_TEST_EXISTING_URL: existingPr,
    },
  });
}

test("審查流程無上游差異時不開空 PR，且不推送任何候選分支", () => {
  withTemporaryRepository((root) => {
    const deployment = createReviewDeployment(root);
    const result = runReviewWorkflow(root, deployment);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(remoteBranch(deployment.worktree, "main"), deployment.main);
    assert.equal(
      remoteBranch(deployment.worktree, "codex/upstream-update"),
      "",
    );
    assert.equal(existsSync(path.join(root, "pr.log")), false);
  });
});

test("更新只進 PR 分支，重跑沿用同一 PR 且不執行候選 updater", () => {
  withTemporaryRepository((root) => {
    const deployment = createReviewDeployment(root);
    const upstream = deployment.upstream;
    write(upstream.worktree, "app.txt", "version 2\n");
    write(
      upstream.worktree,
      "scripts/sync-upstream.mjs",
      'throw new Error("unreviewed updater must not execute");\n',
    );
    const version2 = commitAll(upstream.worktree, "upstream v2");
    git(upstream.worktree, "push", "origin", "main");

    const first = runReviewWorkflow(root, deployment);
    assert.equal(first.status, 0, first.stderr);
    const candidate = remoteBranch(
      deployment.worktree,
      "codex/upstream-update",
    );
    assert.notEqual(candidate, deployment.main);
    assert.equal(remoteBranch(deployment.worktree, "main"), deployment.main);
    assert.match(readFileSync(path.join(root, "pr.log"), "utf8"), /pr create/);
    assert.equal(
      git(deployment.worktree, "show", `${candidate}:app.txt`),
      "version 2",
    );
    assert.equal(
      git(
        deployment.worktree,
        "show",
        `${candidate}:.github/workflows/sync-upstream.yml`,
      ),
      "name: reviewed",
    );

    git(deployment.worktree, "switch", "main");
    git(deployment.worktree, "branch", "-D", "codex/upstream-update");
    const second = runReviewWorkflow(root, deployment, {
      existingPr: "https://github.com/example/deployment/pull/1",
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(
      remoteBranch(deployment.worktree, "codex/upstream-update"),
      candidate,
    );
    assert.equal(remoteBranch(deployment.worktree, "main"), deployment.main);
    const log = readFileSync(path.join(root, "pr.log"), "utf8");
    assert.equal(log.match(/pr create/g)?.length, 1);
    assert.equal(log.match(/pr edit/g)?.length, 1);

    write(upstream.worktree, "app.txt", "version 3\n");
    commitAll(upstream.worktree, "upstream v3");
    git(upstream.worktree, "push", "origin", "main");
    git(deployment.worktree, "switch", "main");
    git(deployment.worktree, "branch", "-D", "codex/upstream-update");
    const third = runReviewWorkflow(root, deployment, {
      existingPr: "https://github.com/example/deployment/pull/1",
    });
    assert.equal(third.status, 0, third.stderr);
    const updated = remoteBranch(deployment.worktree, "codex/upstream-update");
    assert.notEqual(updated, candidate);
    assert.equal(remoteBranch(deployment.worktree, "main"), deployment.main);
    assert.equal(
      git(deployment.worktree, "show", `${updated}:app.txt`),
      "version 3",
    );
    assert.match(
      git(deployment.worktree, "log", "--format=%B"),
      new RegExp(version2),
    );
  });
});

test("審查流程遇到程式碼衝突會停止，不寫 main 或建立 PR", () => {
  withTemporaryRepository((root) => {
    const deployment = createReviewDeployment(root);
    write(deployment.worktree, "app.txt", "private change\n");
    const main = commitAll(deployment.worktree, "customize main");
    git(deployment.worktree, "push", "origin", "main");
    write(deployment.upstream.worktree, "app.txt", "upstream change\n");
    commitAll(deployment.upstream.worktree, "conflicting upstream");
    git(deployment.upstream.worktree, "push", "origin", "main");
    const result = runReviewWorkflow(root, deployment);
    assert.notEqual(result.status, 0);
    assert.equal(remoteBranch(deployment.worktree, "main"), main);
    assert.equal(
      remoteBranch(deployment.worktree, "codex/upstream-update"),
      "",
    );
    assert.equal(existsSync(path.join(root, "pr.log")), false);
  });
});

test("三方合併發生程式碼衝突時不改 working tree 且不 push", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root, { includeSecondCommit: false });
    const originBare = path.join(root, "deployment.git");
    initializeBareRepository(originBare);
    git(upstream.worktree, "remote", "add", "deployment", originBare);
    git(upstream.worktree, "push", "deployment", "main");

    const runner = path.join(root, "runner");
    cloneRepository(originBare, runner);
    write(runner, "app.txt", "deployment change\n");
    const deploymentCommit = commitAll(runner, "deployment change");
    git(runner, "push", "origin", "main");

    write(upstream.worktree, "app.txt", "upstream change\n");
    commitAll(upstream.worktree, "upstream change");
    git(upstream.worktree, "push", "origin", "main");

    const result = runUpdater(runner, upstream.bare);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CONFLICT|發生衝突/);
    assert.equal(remoteBranch(runner, "main"), deploymentCommit);
    assert.equal(git(runner, "rev-parse", "HEAD"), deploymentCommit);
    assert.equal(git(runner, "status", "--porcelain"), "");
  });
});

test("先前同步後的非衝突使用者修改會保留，且不引入上游 parent", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);
    const firstResult = runUpdater(deployment.worktree, upstream.bare);
    assert.equal(firstResult.status, 0, firstResult.stderr);

    write(deployment.worktree, "user-note.txt", "deployment note\n");
    const userCommit = commitAll(deployment.worktree, "user note");
    git(deployment.worktree, "push", "origin", "main");

    write(upstream.worktree, "upstream-v3.txt", "upstream v3\n");
    const upstreamV3 = commitAll(upstream.worktree, "upstream v3");
    git(upstream.worktree, "push", "origin", "main");

    const result = runUpdater(deployment.worktree, upstream.bare);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(deployment.worktree, "show", "HEAD:user-note.txt"),
      "deployment note",
    );
    assert.equal(
      git(deployment.worktree, "show", "HEAD:upstream-v3.txt"),
      "upstream v3",
    );
    assert.deepEqual(
      git(
        deployment.worktree,
        "rev-list",
        "--parents",
        "-n",
        "1",
        "HEAD",
      ).split(" "),
      [git(deployment.worktree, "rev-parse", "HEAD"), userCommit],
    );
    assert.notEqual(
      run("git", ["merge-base", "--is-ancestor", upstreamV3, "HEAD"], {
        cwd: deployment.worktree,
        allowFailure: true,
      }).status,
      0,
    );
    assert.match(
      git(deployment.worktree, "show", "-s", "--format=%B", "HEAD"),
      new RegExp(`Taiwan-Fin-Hub-Upstream: ${upstreamV3}`),
    );
  });
});

test("獨立部署辨識匯入與同步版本，自行新增 commit 後顯示未知", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    assert.equal(
      getBuildInfo(upstream.worktree, upstream.bare).commit,
      upstream.latestCommit,
    );
    const deployment = createImportedDeployment(root, upstream);
    git(
      deployment.worktree,
      "push",
      "origin",
      `${deployment.rootCommit}:refs/heads/imported-snapshot`,
    );

    const buildCheckout = path.join(root, "cloudflare-build");
    run("git", [
      "clone",
      "--depth=1",
      "--branch=imported-snapshot",
      pathToFileURL(deployment.bare).href,
      buildCheckout,
    ]);
    const imported = getBuildInfo(buildCheckout, upstream.bare);
    assert.equal(imported.repository, "TedLin1993/all-set-tw");
    assert.equal(imported.commit, upstream.firstCommit);
    assert.equal(imported.branch, "main");
    assert.ok(Number.isFinite(Date.parse(imported.builtAt)));
    assert.equal(
      getBuildInfo(deployment.worktree, upstream.bare).commit,
      "未知",
    );
    git(buildCheckout, "fetch", "--depth=1", "origin", "main");
    git(buildCheckout, "checkout", "--detach", "FETCH_HEAD");
    assert.equal(getBuildInfo(buildCheckout, upstream.bare).commit, "未知");

    const result = runUpdater(deployment.worktree, upstream.bare);
    assert.equal(result.status, 0, result.stderr);
    const synced = getBuildInfo(deployment.worktree, upstream.bare);
    assert.equal(synced.commit, upstream.latestCommit);
    assert.equal(synced.branch, "main");

    const syncedCheckout = path.join(root, "synced-build");
    run("git", [
      "clone",
      "--depth=1",
      pathToFileURL(deployment.bare).href,
      syncedCheckout,
    ]);
    assert.equal(
      getBuildInfo(syncedCheckout, upstream.bare).commit,
      upstream.latestCommit,
    );

    write(deployment.worktree, "user-note.txt", "deployment note\n");
    commitAll(deployment.worktree, "user note");
    git(deployment.worktree, "checkout", "-b", "private-deployment");

    const customized = getBuildInfo(deployment.worktree, upstream.bare);
    assert.equal(customized.commit, "未知");
    assert.equal(customized.branch, "main");

    git(deployment.worktree, "push", "origin", "private-deployment");
    const customizedCheckout = path.join(root, "customized-build");
    run("git", [
      "clone",
      "--depth=1",
      "--branch=private-deployment",
      pathToFileURL(deployment.bare).href,
      customizedCheckout,
    ]);
    assert.equal(
      getBuildInfo(customizedCheckout, upstream.bare).commit,
      "未知",
    );
  });
});
