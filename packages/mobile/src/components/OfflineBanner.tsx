// Bandeau hors-ligne discret — affiché en haut de l'écran quand isOnline=false.
// Deux états : données en cache (avec fraîcheur relative) ou aucune donnée cachée.
//
// Le texte "il y a X min" se rafraîchit toutes les 60s via setInterval.
// Date.now() n'est JAMAIS appelé pendant le render (react-hooks/purity) :
// - useState(Date.now) : passe la référence, React l'appelle une seule fois au montage.
// - setInterval callback : code asynchrone, hors render.

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatRelativeTime } from '../utils/formatRelativeTime';

const REFRESH_INTERVAL_MS = 60_000;

export interface OfflineBannerProps {
  /** Epoch ms du dernier sync réseau. null = jamais synchronisé. */
  readonly lastSyncedAt: number | null;
  /**
   * Epoch ms « maintenant » — injecté pour les tests (évite Date.now() en render).
   * En production, le composant gère lui-même le tick toutes les 60s.
   */
  readonly nowMs?: number;
}

export function OfflineBanner({ lastSyncedAt, nowMs: nowMsProp }: OfflineBannerProps) {
  // useState(Date.now) : RÉFÉRENCE passée comme initializer, appelée une seule fois.
  const [tickMs, setTickMs] = useState(Date.now);

  useEffect(() => {
    if (nowMsProp !== undefined) return; // prop de test injectée : pas de tick autonome
    const id = setInterval(() => {
      setTickMs(Date.now());
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [nowMsProp]);

  const resolvedNowMs = nowMsProp ?? tickMs;

  const message =
    lastSyncedAt !== null
      ? `Vous êtes hors-ligne. Données datant de ${formatRelativeTime(lastSyncedAt, resolvedNowMs)}.`
      : 'Vous êtes hors-ligne. Aucune donnée disponible.';

  return (
    <View
      style={styles.banner}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#5c5c5c',
    paddingVertical: 6,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  text: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
  },
});
