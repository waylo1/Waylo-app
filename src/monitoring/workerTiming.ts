/**
 * workerTiming — registre EN MÉMOIRE des durées des dernières boucles de workers.
 *
 * Chaque worker enregistre la durée (ms) de chacun de ses ticks via
 * `recordWorkerLoop`. On conserve au plus les `MAX_SAMPLES` derniers échantillons
 * par worker (fenêtre glissante) ; `getWorkerTimings` en dérive la moyenne, lue par
 * GET /debug/performance.
 *
 * Volontairement mono-process et non persistant : c'est un profil de latence
 * « live » de l'instance courante, pas une métrique historique. Coût O(1) par tick,
 * empreinte bornée (MAX_SAMPLES × nombre de workers).
 */

/** Fenêtre glissante : moyenne sur les 10 dernières boucles, comme spécifié. */
export const MAX_SAMPLES = 10

const samples = new Map<string, number[]>()

/** Enregistre la durée (ms) d'un tick de `worker`. Conserve les MAX_SAMPLES derniers. */
export function recordWorkerLoop(worker: string, durationMs: number): void {
  const arr = samples.get(worker) ?? []
  arr.push(durationMs)
  if (arr.length > MAX_SAMPLES) arr.shift()
  samples.set(worker, arr)
}

export interface WorkerTiming {
  worker: string
  /** Nombre d'échantillons retenus (≤ MAX_SAMPLES). */
  samples: number
  /** Moyenne des durées retenues (ms), arrondie au centième. */
  avgMs: number
  /** Durée du dernier tick (ms). */
  lastMs: number
}

/** Snapshot des moyennes par worker (lecture seule). */
export function getWorkerTimings(): WorkerTiming[] {
  const out: WorkerTiming[] = []
  for (const [worker, arr] of samples) {
    if (arr.length === 0) continue
    const sum = arr.reduce((a, b) => a + b, 0)
    out.push({
      worker,
      samples: arr.length,
      avgMs: Math.round((sum / arr.length) * 100) / 100,
      lastMs: Math.round((arr[arr.length - 1] as number) * 100) / 100,
    })
  }
  return out
}

/** Vide le registre — usage tests uniquement (isolation entre cas). */
export function resetWorkerTimings(): void {
  samples.clear()
}
