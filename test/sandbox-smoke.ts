// Opt-in local probe, not part of npm test and not the production executor.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const image = process.argv[2];
if (!image || !/^sha256:[a-f0-9]{64}$/.test(image)) {
  throw new Error("Supply an existing local Node.js image ID (sha256:...), not a mutable tag.");
}

const probe = `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
assert.equal(process.getuid(), 65534);
assert.equal(process.env.BOC_SANDBOX_CANARY, undefined);
assert.equal(fs.existsSync('/var/run/docker.sock'), false);
assert.throws(() => fs.writeFileSync('/boc-root-probe', 'blocked'));
// Permission denial alone does not prove a read-only filesystem for a non-root UID.
const rootMount = fs.readFileSync('/proc/self/mountinfo', 'utf8')
  .split('\\n').map(line => line.split(' ')).find(fields => fields[4] === '/');
assert.ok(rootMount && rootMount[5].split(',').includes('ro'), 'root mount must be read-only');
assert.ok(Object.values(os.networkInterfaces()).flat().every(nic => nic.internal));
const status = fs.readFileSync('/proc/self/status', 'utf8');
assert.match(status, /^CapEff:\\s+0+$/m);
assert.match(status, /^NoNewPrivs:\\s+1$/m);
fs.writeFileSync('/work/probe', 'writable');
assert.equal(fs.readFileSync('/work/probe', 'utf8'), 'writable');
console.log('Sandbox smoke passed: non-root, no external interface, no inherited canary, read-only root, no effective capabilities, no-new-privileges, writable scratch.');
`;

const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=64",
    "--memory=128m",
    "--cpus=1",
    "--user=65534:65534",
    "--tmpfs=/work:rw,nosuid,nodev,size=16m,uid=65534,gid=65534,mode=700",
    "--workdir=/work",
    "--entrypoint=node",
    image,
    "-e",
    probe,
  ],
  {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    // The Docker client needs its local context; none of these values are passed
    // into the container with -e or --env-file. The image must be operator-trusted.
    env: { ...process.env, BOC_SANDBOX_CANARY: "synthetic-canary-not-a-secret" },
  },
);
assert.equal(result.status, 0, result.error?.message ?? result.stderr);
process.stdout.write(result.stdout);
