import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import type { TestProject } from 'vitest/node'
import { exec } from '../../lib/exec.ts'
import { decisionRoot } from '../../lib/project-setup.ts'
import { webFacets } from '../../server/web.ts'
import type { WebBuildRequest, WebBuildResult } from '../../server/web-build.ts'

/** The web bundle of this checkout, built once per run for every test server whose home runs on a source copy. */
export type SharedWebBundle = { root: string; bundle: string; inputs: string[]; facets: string[] }

declare module 'vitest' {
  interface ProvidedContext {
    webBundle?: SharedWebBundle
  }
}

export default async function buildSharedWebBundle(project: TestProject) {
  const root = resolve('.')
  const folder = await mkdtemp(join(tmpdir(), 'ultimate-test-web-'))
  const userHome = join(folder, 'user')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  new ProjectTrustStore(join(userHome, '.ultimate')).set(decisionRoot(root), true)
  const request: WebBuildRequest = {
    ultimateRoot: root,
    projectRoot: root,
    userHome,
    outDir: join(folder, 'bundle'),
    cacheDir: join(folder, 'vite'),
    broken: {},
  }
  const { stdout } = await exec(
    process.execPath,
    [resolve('server/web-build.ts'), JSON.stringify(request)],
    { cwd: root, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_ENV: 'production' } },
  )
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!) as WebBuildResult
  if (!('inputs' in result))
    throw new Error(`The web UI did not build for the e2e run: ${result.error.message}`)
  project.provide('webBundle', {
    root,
    bundle: request.outDir,
    inputs: result.inputs.filter((file) => !file.includes('/node_modules/')),
    facets: await webFacets(root, root, userHome),
  })
  return () => rm(folder, { recursive: true, force: true })
}
