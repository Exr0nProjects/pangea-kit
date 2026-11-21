// Deploy provenance (PANGEA3-DESIGN §17, DESIGN-CONFORMANCE §D/§E 5a; census A35, C27, D "deploy from a shared tree").
// A release is built from a commit, never from a working tree: the app and the kit must each be clean and on main, and the
// build tree is a `git archive` export of HEAD (no worktree registration, nothing written into the shared repo).
// BUILD.json names exactly what shipped: {app, app_sha, kit_sha, app_lock_sha256, kit_lock_sha256, dirty:false, build_id}.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export class ProvenanceRefused extends Error {}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); // git's own stderr rides on the thrown error, not the terminal

/** The git state of `dir` (a repo or a subdirectory of one): top, sha, branch and the dirty entries under `dir` only. */
export function gitState(dir) {
  dir = realpathSync(resolve(dir));
  const top = realpathSync(git(dir, ['rev-parse', '--show-toplevel']));
  const sub = relative(top, dir) || '.';
  const porcelain = git(top, ['status', '--porcelain', '--untracked-files=all', '--', sub]);
  return {
    dir, top, sub,
    sha: git(top, ['rev-parse', 'HEAD']),
    branch: git(top, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: porcelain ? porcelain.split('\n') : [],
  };
}

/** Refuse unless `dir` is clean and on `branch`. `label` names it in the refusal ("app", "kit"). */
export function assertClean(dir, { label = dir, branch = 'main' } = {}) {
  const s = gitState(dir);
  const why = [];
  // a detached checkout counts only when it is exactly the tip of `branch` (a clean worktree of main's HEAD)
  const tip = (() => { try { return git(s.top, ['rev-parse', `refs/heads/${branch}`]); } catch { return null; } })();
  if (s.branch !== branch && !(s.branch === 'HEAD' && s.sha === tip)) why.push(`${label} is on ${s.branch === 'HEAD' ? `a detached ${s.sha.slice(0, 12)} that is not the tip of ${branch}` : `branch ${s.branch}`}, not ${branch}`);
  if (s.dirty.length) why.push(`${label} has ${s.dirty.length} uncommitted change(s) under ${s.sub}: ${s.dirty.slice(0, 8).join('; ')}${s.dirty.length > 8 ? '; ...' : ''}`);
  if (why.length) throw new ProvenanceRefused(`deploy refused: ${why.join('. ')}. Commit (by pathspec) or wait for the owner of those files; a release is built from a commit, never a working tree`);
  return s;
}

/** Export `sub` of the repo at `top` as of `sha` into `dest` (git archive | tar -x). Returns dest. */
export function exportTree(top, sha, sub, dest) {
  mkdirSync(dest, { recursive: true });
  const strip = sub === '.' ? 0 : sub.split('/').length;
  const tar = execFileSync('git', ['archive', '--format=tar', sha, ...(sub === '.' ? [] : [sub])], { cwd: top, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-f', '-', '-C', dest, ...(strip ? [`--strip-components=${strip}`] : [])], { input: tar, maxBuffer: 1 << 30 });
  return dest;
}

export const sha256File = (f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : null);

/** node_modules is not in git: link the live checkout's, after checking the lockfile it was installed from is the committed one. */
export function linkNodeModules(liveDir, exportDir, { label }) {
  const live = join(liveDir, 'node_modules');
  if (!existsSync(live)) throw new ProvenanceRefused(`deploy refused: ${label} has no node_modules (run npm ci in ${liveDir})`);
  const installed = sha256File(join(live, '.package-lock.json'));
  const committed = sha256File(join(exportDir, 'package-lock.json'));
  if (committed && installed) {
    // npm's hidden lockfile (node_modules/.package-lock.json) records what is installed: every installed version must be
    // the committed lockfile's, and every non-optional committed package must be installed
    const want = JSON.parse(readFileSync(join(exportDir, 'package-lock.json'), 'utf8')).packages || {};
    const have = JSON.parse(readFileSync(join(live, '.package-lock.json'), 'utf8')).packages || {};
    const bad = [];
    for (const [k, v] of Object.entries(have)) if (k && want[k] && want[k].version !== v.version) bad.push(`${k} ${v.version} != ${want[k].version}`);
    for (const [k, v] of Object.entries(want)) if (k.startsWith('node_modules/') && !v.optional && !v.peer && !have[k]) bad.push(`${k} missing`);
    if (bad.length) throw new ProvenanceRefused(`deploy refused: ${label} node_modules differs from the committed package-lock.json (${bad.slice(0, 5).join('; ')}); run npm ci in ${liveDir}`);
  }
  symlinkSync(live, join(exportDir, 'node_modules'), 'dir');
}

export function buildId(appSha, kitSha) { return `${appSha.slice(0, 12)}.${kitSha.slice(0, 12)}`; }
