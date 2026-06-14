/**
 * TEMPORAIRE — test réseau Stripe réel sans bloquer le terminal.
 * 1) stripe listen --forward-to localhost:3000/api/stripe/webhook (bg, parse whsec)
 * 2) backend :3000 (bg) avec ce whsec
 * 3) stripe trigger payment_intent.succeeded  → tunnel doit répondre [200]
 * 4) npm run test:e2e (logique métier, in-memory waylo_test)
 * 5) kill propre stripe + backend
 * Prérequis : Stripe CLI installée + `stripe login`. À supprimer après usage.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

const sh = (cmd: string, args: string[]): ChildProcess =>
  spawn(cmd, args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const kill = (p?: ChildProcess): void => { if (p?.pid) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }) }

const hasStripe = spawnSync('stripe', ['--version'], { shell: true }).status === 0
if (!hasStripe) {
  console.error('❌ BLOQUÉ : Stripe CLI absente. `winget install Stripe.StripeCLI` puis `stripe login`.')
  process.exit(2)
}

let listen: ChildProcess | undefined
let backend: ChildProcess | undefined
const fin = (code: number): never => { kill(listen); kill(backend); process.exit(code) }

// 1) listen + parse whsec
listen = sh('stripe', ['listen', '--forward-to', 'localhost:3000/api/stripe/webhook'])
let whsec = ''
let ready = false
const onData = (b: Buffer): void => {
  const s = b.toString()
  process.stdout.write('[listen] ' + s)
  const m = s.match(/whsec_[A-Za-z0-9]+/)
  if (m) whsec = m[0]
  if (/Ready|waiting for events/i.test(s)) ready = true
}
listen.stdout?.on('data', onData)
listen.stderr?.on('data', onData)

for (let i = 0; i < 30 && !(ready && whsec); i++) await sleep(500)
if (!whsec) { console.error('❌ whsec non détecté (login requis ?).'); fin(1) }
console.log('whsec=' + whsec.slice(0, 12) + '…')

// 2) backend :3000 avec ce whsec
backend = spawn('npm', ['--prefix', process.cwd(), 'run', 'dev'], {
  shell: true, stdio: 'ignore',
  env: { ...process.env,
    DATABASE_URL: 'postgresql://flipsync:flipsync@localhost:5433/waylo',
    STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: whsec,
    STRIPE_ISSUING_WEBHOOK_SECRET: 'whsec_issuing_dummy', JWT_SECRET: 'jwt_real_webhook' },
})
let up = false
for (let i = 0; i < 40; i++) {
  try { if ((await fetch('http://localhost:3000/health')).ok) { up = true; break } } catch { /* */ }
  await sleep(500)
}
console.log('backend_up=' + up)
if (!up) { console.error('❌ backend :3000 KO'); fin(1) }

// 3) trigger réel → le tunnel doit forwarder en [200]
const trig = spawnSync('stripe', ['trigger', 'payment_intent.succeeded'], { shell: true, encoding: 'utf8' })
console.log('[trigger] status=' + trig.status)
await sleep(4000) // laisser le forward + log [200] arriver

// 4) logique métier complète
const e2e = spawnSync('npm', ['run', 'test:e2e'], { shell: true, stdio: 'inherit' })
console.log('test:e2e exit=' + e2e.status)

// 5) cleanup
console.log(e2e.status === 0 ? '✅ flux réseau Stripe + e2e : OK' : '❌ échec')
fin(e2e.status === 0 ? 0 : 1)
