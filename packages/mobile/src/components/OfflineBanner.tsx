// Bandeau hors-ligne discret — affiché en haut de l'écran quand isOnline=false.
// Deux états : données en cache (avec fraîcheur relative) ou aucune donnée cachée.

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatRelativeTime } from '../utils/formatRelativeTime';

export interface OfflineBannerProps {
  /** Epoch ms du dernier sync réseau. null = jamais synchronisé. */
  readonly lastSyncedAt: number | null;
  /**
   * Epoch ms « maintenant » — injecté pour les tests (évite Date.now() en render).
   * En production, le composant capture Date.now au montage via useState(Date.now).
   */
  readonly nowMs?: number;
}

export function OfflineBanner({ lastSyncedAt, nowMs: nowMsProp }: OfflineBannerProps) {
  // useState(Date.now) passe la RÉFÉRENCE (pas un appel) — React l'appelle une seule
  // fois au montage, ce qui satisfait la règle react-hooks/purity.
  const [mountedAt] = useState(Date.now);
  const resolvedNowMs = nowMsProp ?? mountedAt;

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
