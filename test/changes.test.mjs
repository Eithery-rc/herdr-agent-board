import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkoutChanges } from '../src/changes.mjs'
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'board-git-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const git = args => execFileSync('git', ['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-C',dir,...args], { encoding:'utf8' })
  git(['init','--quiet'])
  writeFileSync(join(dir,'tracked.txt'),'before\n')
  git(['add','tracked.txt']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture'])
  return { dir,git }
}
test('preview resolves the exact worktree, includes staged/unstaged names, preserves index and disables external diff', async t => {
  const {dir,git}=repo(t)
  writeFileSync(join(dir,'tracked.txt'),'staged\n');git(['add','tracked.txt'])
  writeFileSync(join(dir,'tracked.txt'),'unstaged\n');writeFileSync(join(dir,'new.txt'),'not read')
  git(['config','diff.external','this-command-must-never-run'])
  const index=readFileSync(join(dir,'.git/index'))
  const out=await checkoutChanges(dir)
  assert.equal(out.available,true);assert.equal(out.root,realpathSync(dir))
  assert.match(out.diff,/unstaged/);assert.match(out.status,/new.txt/)
  assert.deepEqual(readFileSync(join(dir,'.git/index')),index)
  const worktree=join(dir,'sibling');git(['worktree','add','--quiet','-b','sibling',worktree])
  writeFileSync(join(worktree,'tracked.txt'),'only sibling\n')
  const sibling=await checkoutChanges(worktree)
  assert.match(sibling.diff,/only sibling/);assert.doesNotMatch(sibling.diff,/unstaged/)
  assert.equal(sibling.branch,'sibling')
  writeFileSync(join(worktree,'tracked.txt'),'x'.repeat(400000))
  const bounded=await checkoutChanges(worktree)
  assert.equal(bounded.available,true);assert.equal(bounded.truncated,true)
  assert.ok(bounded.diff.length <= 256*1024)
})
test('missing cwd, non-repository and unborn repository are unavailable', async t => {
  const dir=mkdtempSync(join(tmpdir(),'board-no-git-'));t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}))
  assert.equal((await checkoutChanges(null)).available,false)
  assert.equal((await checkoutChanges(dir)).available,false)
  execFileSync('git',['init','--quiet',dir])
  assert.equal((await checkoutChanges(dir)).available,false)
})
