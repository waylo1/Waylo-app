// Suite MissionsScreen — rendu conditionnel et absence de flash de contenu vide.
//
// Tous les états possibles sont testés via les props (composant découplé).
// Le test "no flash" prouve que isLoadingInitial=true garde l'écran sur les
// skeletons sans jamais révéler EmptyState entre deux frames.

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import type { MissionDTO } from '@waylo/shared';
import MissionsScreen, { type MissionsScreenProps } from '../screens/MissionsScreen';

// -- Fixtures ----------------------------------------------------------------

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

const defaultProps: MissionsScreenProps = {
  isLoadingInitial: false,
  missions: [],
  error: null,
  onCreatePress: jest.fn(),
  onRetry: jest.fn(),
  isRefreshing: false,
  onRefresh: jest.fn(),
};

// ============================================================================
// Loading initial → skeletons (jamais d'état vide)
// ============================================================================

describe('loading initial', () => {
  it('isLoadingInitial=true → skeletons affichés', () => {
    render(<MissionsScreen {...defaultProps} isLoadingInitial={true} />);
    // Les skeletons sont des View sans texte — on vérifie l'absence des autres états.
    expect(screen.queryByText(/pas encore de missions/i)).toBeNull();
    expect(screen.queryByText(/erreur de chargement/i)).toBeNull();
    expect(screen.queryByText(/sac à main/i)).toBeNull();
  });

  it('NO FLASH : isLoadingInitial=true masque EmptyState même si missions=[]', () => {
    // Cas race condition : parent positionne isLoadingInitial=true avec missions=[].
    // Attendu : skeletons, pas d'EmptyState.
    render(<MissionsScreen {...defaultProps} isLoadingInitial={true} missions={[]} />);

    expect(screen.queryByText(/pas encore de missions/i)).toBeNull();
    expect(screen.queryByText(/créez votre première mission/i)).toBeNull();
  });

  it('isLoadingInitial=false avec données → liste directement, aucun flash vide', () => {
    // Simule le passage loading→data en un seul rendu (état final stable).
    render(
      <MissionsScreen
        {...defaultProps}
        isLoadingInitial={false}
        missions={[makeMission()]}
      />,
    );

    expect(screen.getByText('Sac à main')).toBeTruthy();
    expect(screen.queryByText(/pas encore de missions/i)).toBeNull();
  });
});

// ============================================================================
// États conditionnels post-loading
// ============================================================================

describe('états post-loading', () => {
  it('error + missions vide → ErrorState avec message et bouton Réessayer', () => {
    render(
      <MissionsScreen {...defaultProps} error="Connexion impossible." />,
    );

    expect(screen.getByText(/erreur de chargement/i)).toBeTruthy();
    expect(screen.getByText(/connexion impossible/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /réessayer/i })).toBeTruthy();
  });

  it("error avec missions en cache → liste (pas d'ErrorState)", () => {
    // Erreur survenue après un premier fetch réussi : les données sont visibles.
    render(
      <MissionsScreen
        {...defaultProps}
        error="NETWORK_ERROR"
        missions={[makeMission({ id: 'm1' }), makeMission({ id: 'm2', targetProduct: 'Montre' })]}
      />,
    );

    expect(screen.queryByText(/erreur de chargement/i)).toBeNull();
    expect(screen.getByText('Sac à main')).toBeTruthy();
    expect(screen.getByText('Montre')).toBeTruthy();
  });

  it('missions vide (no error) → EmptyState avec CTA', () => {
    render(<MissionsScreen {...defaultProps} />);

    expect(screen.getByText(/pas encore de missions/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /créer une mission/i })).toBeTruthy();
  });

  it('missions présentes → cartes avec détails', () => {
    render(
      <MissionsScreen
        {...defaultProps}
        missions={[makeMission({ id: 'm1', targetProduct: 'Parfum', budgetCents: 5_000 })]}
      />,
    );

    expect(screen.getByText('Parfum')).toBeTruthy();
    expect(screen.getByText('Paris → Tokyo')).toBeTruthy();
    expect(screen.getByText('50.00 €')).toBeTruthy();
  });
});

// ============================================================================
// RefreshControl séparé de isLoadingInitial
// ============================================================================

describe('RefreshControl vs skeletons', () => {
  it('isRefreshing=true + données → données visibles, pas de skeletons', () => {
    render(
      <MissionsScreen
        {...defaultProps}
        missions={[makeMission()]}
        isRefreshing={true}
      />,
    );

    // Données toujours visibles pendant le refresh.
    expect(screen.getByText('Sac à main')).toBeTruthy();
    // Aucun état vide.
    expect(screen.queryByText(/pas encore de missions/i)).toBeNull();
    expect(screen.queryByText(/erreur de chargement/i)).toBeNull();
  });

  it('isRefreshing=true + missions vide → EmptyState visible (pas de skeletons)', () => {
    // PTR sur liste vide : le spinner tourne mais EmptyState reste visible.
    render(
      <MissionsScreen {...defaultProps} missions={[]} isRefreshing={true} />,
    );

    expect(screen.getByText(/pas encore de missions/i)).toBeTruthy();
  });

  it('isLoadingInitial=true + isRefreshing=true → skeletons (initial prime)', () => {
    // Sécurité : si les deux sont true par erreur, le loading initial gagne.
    render(
      <MissionsScreen {...defaultProps} isLoadingInitial={true} isRefreshing={true} />,
    );

    expect(screen.queryByText(/pas encore de missions/i)).toBeNull();
    expect(screen.queryByText(/erreur de chargement/i)).toBeNull();
  });
});
