// Suite OfflineBanner — rendu des deux états (avec/sans cache) et fraîcheur.

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { OfflineBanner } from '../components/OfflineBanner';

const NOW = 1_700_010_000_000; // référence fixe
const MIN = 60_000;
const H = 60 * MIN;

describe('OfflineBanner', () => {
  it('lastSyncedAt=null → "Aucune donnée disponible"', () => {
    render(<OfflineBanner lastSyncedAt={null} nowMs={NOW} />);
    expect(screen.getByText(/aucune donnée disponible/i)).toBeTruthy();
    expect(screen.getByText(/hors-ligne/i)).toBeTruthy();
  });

  it('lastSyncedAt récent (5 min) → "quelques secondes" ou minutes', () => {
    // 5 min d'écart
    render(<OfflineBanner lastSyncedAt={NOW - 5 * MIN} nowMs={NOW} />);
    expect(screen.getByText(/5 min/)).toBeTruthy();
    expect(screen.getByText(/hors-ligne/i)).toBeTruthy();
  });

  it('lastSyncedAt = il y a 2h → "il y a 2 h"', () => {
    render(<OfflineBanner lastSyncedAt={NOW - 2 * H} nowMs={NOW} />);
    expect(screen.getByText(/2 h/)).toBeTruthy();
  });

  it('lastSyncedAt = quelques secondes', () => {
    render(<OfflineBanner lastSyncedAt={NOW - 30_000} nowMs={NOW} />);
    expect(screen.getByText(/quelques secondes/)).toBeTruthy();
  });

  it('déclare accessibilityRole="alert" sur le conteneur', () => {
    render(<OfflineBanner lastSyncedAt={null} nowMs={NOW} />);
    // getByRole('alert') n'est pas supporté par RNTL pour les rôles natifs RN —
    // on vérifie la prop directement.
    const elements = screen.UNSAFE_getAllByProps({ accessibilityRole: 'alert' });
    expect(elements.length).toBeGreaterThanOrEqual(1);
  });
});
