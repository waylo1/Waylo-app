// Suite MissionsScreen — états offline (bandeau + NoOfflineDataState).
// Complémentaire à MissionsScreen.test.tsx (états en ligne).

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import type { MissionDTO } from '@waylo/shared';
import MissionsScreen, { type MissionsScreenProps } from '../screens/MissionsScreen';

const NOW = 1_700_010_000_000;
const MIN = 60_000;

function makeMission(overrides: Partial<MissionDTO> = {}): MissionDTO {
  return {
    id: 'm1',
    buyerId: 'buyer1',
    travelerId: null,
    status: 'AWAITING_VALIDATION',
    targetProduct: 'Sac à main',
    budgetCents: 10_000,
    commissionCents: 1_500,
    origin: 'Paris',
    destination: 'Tokyo',
    substitutionAuthorized: false,
    deliveryProofStatus: 'PENDING',
    version: 0,
    expiresAt: '2026-07-01T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

const baseProps: MissionsScreenProps = {
  isLoadingInitial: false,
  missions: [],
  error: null,
  onCreatePress: jest.fn(),
  onRetry: jest.fn(),
  isRefreshing: false,
  onRefresh: jest.fn(),
};

// ============================================================================
// Bandeau hors-ligne
// ============================================================================

describe('bandeau hors-ligne', () => {
  it('isOffline=false → aucun bandeau', () => {
    render(<MissionsScreen {...baseProps} isOffline={false} />);
    expect(screen.queryByText(/hors-ligne/i)).toBeNull();
  });

  it('isOffline=true + lastSyncedAt → bandeau avec fraîcheur', () => {
    render(
      <MissionsScreen
        {...baseProps}
        missions={[makeMission()]}
        isOffline={true}
        lastSyncedAt={NOW - 5 * MIN}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText(/hors-ligne/i)).toBeTruthy();
    expect(screen.getByText(/5 min/)).toBeTruthy();
  });

  it('isOffline=true + lastSyncedAt=null → bandeau "Aucune donnée disponible"', () => {
    render(
      <MissionsScreen
        {...baseProps}
        isOffline={true}
        lastSyncedAt={null}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText(/aucune donnée disponible/i)).toBeTruthy();
  });
});

// ============================================================================
// NoOfflineDataState — hors-ligne + cache vide
// ============================================================================

describe('NoOfflineDataState', () => {
  it('offline + missions=[] + lastSyncedAt=null → écran "aucune donnée hors-ligne"', () => {
    render(
      <MissionsScreen
        {...baseProps}
        isOffline={true}
        missions={[]}
        lastSyncedAt={null}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText(/aucune donnée hors-ligne/i)).toBeTruthy();
    expect(screen.getByText(/reconnectez-vous/i)).toBeTruthy();
    // Pas de CTA création — inutilisable hors-ligne.
    expect(screen.queryByRole('button', { name: /créer/i })).toBeNull();
  });

  it('offline + missions=[] + lastSyncedAt=null → PAS d\'EmptyState', () => {
    render(
      <MissionsScreen
        {...baseProps}
        isOffline={true}
        missions={[]}
        lastSyncedAt={null}
        nowMs={NOW}
      />,
    );
    expect(screen.queryByText(/pas encore de missions/i)).toBeNull();
  });
});

// ============================================================================
// Données cachées disponibles hors-ligne
// ============================================================================

describe('données cachées offline', () => {
  it('offline + missions en cache → liste visible + bandeau', () => {
    render(
      <MissionsScreen
        {...baseProps}
        missions={[makeMission({ targetProduct: 'Montre' })]}
        isOffline={true}
        lastSyncedAt={NOW - 10 * MIN}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText('Montre')).toBeTruthy();
    expect(screen.getByText(/hors-ligne/i)).toBeTruthy();
  });

  it('offline + missions en cache → PAS de NoOfflineDataState', () => {
    render(
      <MissionsScreen
        {...baseProps}
        missions={[makeMission()]}
        isOffline={true}
        lastSyncedAt={NOW - MIN}
        nowMs={NOW}
      />,
    );
    expect(screen.queryByText(/aucune donnée hors-ligne/i)).toBeNull();
  });
});

// ============================================================================
// isLoadingInitial prime toujours (même offline)
// ============================================================================

describe('isLoadingInitial + offline', () => {
  it('isLoadingInitial=true + isOffline=true → skeletons, pas de bandeau', () => {
    render(
      <MissionsScreen
        {...baseProps}
        isLoadingInitial={true}
        isOffline={true}
        lastSyncedAt={null}
        nowMs={NOW}
      />,
    );
    // Skeletons = pas de texte d'état
    expect(screen.queryByText(/hors-ligne/i)).toBeNull();
    expect(screen.queryByText(/aucune donnée/i)).toBeNull();
  });
});
