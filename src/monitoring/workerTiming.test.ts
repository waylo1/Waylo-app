import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_SAMPLES,
  getWorkerTimings,
  recordWorkerLoop,
  resetWorkerTimings,
} from './workerTiming'

/**
 * Registre mémoire des durées de boucles de workers (pur, sans DB).
 * Couvre : moyenne, fenêtre glissante MAX_SAMPLES, isolation par worker, vide.
 */
describe('workerTiming — registre des durées de boucles', () => {
  afterEach(() => resetWorkerTimings())

  it('moyenne, dernier échantillon et compte sur les durées enregistrées', () => {
    recordWorkerLoop('w', 10)
    recordWorkerLoop('w', 20)
    recordWorkerLoop('w', 30)
    const [t] = getWorkerTimings()
    expect(t.worker).toBe('w')
    expect(t.samples).toBe(3)
    expect(t.avgMs).toBe(20)
    expect(t.lastMs).toBe(30)
  })

  it('fenêtre glissante : ne conserve que les MAX_SAMPLES derniers ticks', () => {
    const total = MAX_SAMPLES + 5
    for (let i = 1; i <= total; i++) recordWorkerLoop('w', i)
    const [t] = getWorkerTimings()
    expect(t.samples).toBe(MAX_SAMPLES) // les 5 plus anciens évincés
    expect(t.lastMs).toBe(total) // le dernier poussé
    // Moyenne des MAX_SAMPLES derniers : (6..15) → 10.5 pour MAX_SAMPLES=10.
    const expectedAvg =
      Array.from({ length: MAX_SAMPLES }, (_, k) => total - k).reduce((a, b) => a + b, 0) /
      MAX_SAMPLES
    expect(t.avgMs).toBe(Math.round(expectedAvg * 100) / 100)
  })

  it('workers isolés : un échantillon par worker', () => {
    recordWorkerLoop('a', 5)
    recordWorkerLoop('b', 100)
    const timings = getWorkerTimings()
    expect(timings).toHaveLength(2)
    expect(timings.find(t => t.worker === 'a')?.avgMs).toBe(5)
    expect(timings.find(t => t.worker === 'b')?.avgMs).toBe(100)
  })

  it('registre vide → tableau vide', () => {
    expect(getWorkerTimings()).toEqual([])
  })
})
