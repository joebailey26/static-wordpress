import { extname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { siteRoot, wranglerBin, wranglerConfig } from './site.ts'
import type { WranglerConfig, WranglerEnvironment } from './site.ts'

export interface DeploymentPlan {
  bucket: string
  commands: string[][]
}

export function deploymentPlan(config: WranglerConfig, migrations: WranglerEnvironment | null, preview = false): DeploymentPlan {
  const target = preview ? config.previews : config
  const database = target?.d1_databases?.find(item => item.binding === 'DB')
  const bucket = target?.r2_buckets?.find(item => item.binding === 'FILES')
  if (!database?.database_id || !bucket?.bucket_name) throw new Error('Deployment storage is not configured')
  if (preview) {
    if (config.d1_databases.some(item => item.database_id === database.database_id) || config.r2_buckets.some(item => item.bucket_name === bucket.bucket_name)) throw new Error('Preview deployment cannot use production storage')
    const migrationDatabase = migrations?.d1_databases?.find(item => item.binding === 'DB')
    if (migrationDatabase?.database_id !== database.database_id || migrationDatabase?.database_name !== database.database_name || migrationDatabase?.migrations_dir !== database.migrations_dir) throw new Error('Preview migrations must target the Preview database')
    if (target?.vars?.CMS_TRIGGER_BUILDS !== 'false') throw new Error('Preview website builds must be disabled')
  }

  return {
    bucket: bucket.bucket_name,
    commands: [
      ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', ...(preview ? ['--config', 'wrangler.preview-migrations.jsonc'] : [])],
      ['upload-runtime', ...(preview ? ['--preview'] : [])],
      ['wrangler', preview ? 'preview' : 'deploy']
    ]
  }
}

export async function executeDeployment(plan: DeploymentPlan, run: (command: string[]) => Promise<void>): Promise<void> {
  for (const command of plan.commands) await run(command)
}

export async function main(): Promise<void> {
  const root = siteRoot()
  const config = await wranglerConfig(root)
  const preview = process.argv.includes('--preview')
  const migrations = preview ? await wranglerConfig(root, 'wrangler.preview-migrations.jsonc') : null
  const plan = deploymentPlan(config, migrations, preview)
  // eslint-disable-next-line no-console -- command-line output
  console.log(`Deploying ${preview ? 'preview' : 'production'}; runtime bucket: ${plan.bucket}`)
  await executeDeployment(plan, async ([tool, ...args]) => {
    // The sibling script: .ts when running from source, .js once compiled.
    const script = tool === 'wrangler' ? wranglerBin(root) : fileURLToPath(new URL(`./upload-runtime${extname(fileURLToPath(import.meta.url))}`, import.meta.url))
    const child = spawn(process.execPath, [script, ...args, ...(tool === 'wrangler' ? [] : ['--root', root])], { cwd: root, stdio: 'inherit' })
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`${tool} failed (${code}); deployment stopped`)))
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
