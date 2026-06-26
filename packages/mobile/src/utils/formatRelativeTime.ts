// Formate une durée relative en français à partir de deux timestamps epoch ms.
// Fonction pure — aucun I/O, testable sans horloge système.

export function formatRelativeTime(epochMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - epochMs) / 1000));
  if (diffSec < 60) return 'il y a quelques secondes';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `il y a ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `il y a ${diffH} h`;
  const diffD = Math.floor(diffH / 24);
  return `il y a ${diffD} j`;
}
