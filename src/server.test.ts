import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { missingRequiredEnv, REQUIRED_ENV_VARS } from './server'

/**
 * (1) Validation env du démarrage : chaque variable requise manquante (ou
 *     vide) est nommée dans le résultat — le serveur refuse de démarrer.
 * (2) GET /health → 200 (sonde de déploiement), sans toucher à la DB.
 */

/** Env factice complète : toutes les requises non vides (aucune vraie clé). */
function fullEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://u:p@localhost:5433/waylo_test',
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_async',
    STRIPE_ISSUING_WEBHOOK_SECRET: 'whsec_test_issuing',
    JWT_SECRET: 'jwt_test_secret_waylo',
  }
}

describe('missingRequiredEnv — validation au démarrage', () => {
  it('toutes les variables présentes → aucun manque', () => {
    expect(missingRequiredEnv(fullEnv())).toEqual([])
  })

  it.each([...REQUIRED_ENV_VARS])('%s manquante → nommée dans le résultat', name => {
    const env = fullEnv()
    delete env[name]
    expect(missingRequiredEnv(env)).toEqual([name])
  })

  it('variable présente mais vide = manquante', () => {
    const env = fullEnv()
    env.STRIPE_SECRET_KEY = ''
    expect(missingRequiredEnv(env)).toEqual(['STRIPE_SECRET_KEY'])
  })

  it('toutes manquantes → toutes nommées', () => {
    expect(missingRequiredEnv({})).toEqual([...REQUIRED_ENV_VARS])
  })
})

describe('GET /health', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    // Secrets factices posés AVANT l'import de l'app (lus à l'enregistrement
    // des routes webhook) — même motif que les autres suites.
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
    process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
    process.env.JWT_SECRET = 'jwt_test_secret_waylo'
    app = await (await import('./app')).buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('répond 200 avec status ok (sonde de déploiement)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok' })
  })
})
