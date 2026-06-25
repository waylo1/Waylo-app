// MissionsScreen — liste des missions avec gestion des états (loading/vide/erreur/données).
//
// États du store (une fois intégrée) :
// - loading initial : affiche skeletons (4)
// - refresh (données cached) : scrollable normalement, pas de skeletons
// - vide (0 missions) : EmptyState
// - erreur sans cache : ErrorState
// - données : FlatList de missions
//
// Props piloté par le store — découplé de la logique de fetch.

import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { MissionDTO } from '@waylo/shared';
import { EmptyState } from '../components/states/EmptyState';
import { ErrorState } from '../components/states/ErrorState';
import { LoadingState } from '../components/states/LoadingState';

// -- Props du composant (injectées par l'écran parent ou via le store) -------

export interface MissionsScreenProps {
  /** État de chargement : true si loading initial (premier chargement). */
  readonly isLoadingInitial: boolean;
  /** Missions à afficher. */
  readonly missions: readonly MissionDTO[];
  /** État d'erreur : null si ok, sinon message d'erreur. */
  readonly error: string | null;
  /** Callback pour créer une mission (routes vers CreateMissionScreen). */
  readonly onCreatePress: () => void;
  /** Callback pour réessayer le chargement (bouton Réessayer + pull-to-refresh). */
  readonly onRetry: () => void;
  /**
   * `true` pendant un pull-to-refresh (SÉPARÉ de `isLoadingInitial`).
   * Affiche le spinner natif sur le ScrollView, jamais les skeletons.
   */
  readonly isRefreshing: boolean;
  /** Handler fourni à `RefreshControl` — idempotent si déjà en cours. */
  readonly onRefresh: () => void;
}

// -- Composant ---------------------------------------------------------------

export default function MissionsScreen({
  isLoadingInitial,
  missions,
  error,
  onCreatePress,
  onRetry,
  isRefreshing,
  onRefresh,
}: MissionsScreenProps) {
  // Loading initial : affiche les skeletons (jamais de spinner PTR ici).
  if (isLoadingInitial) {
    return <LoadingState count={4} />;
  }

  const refreshControl = (
    <RefreshControl
      refreshing={isRefreshing}
      onRefresh={onRefresh}
      tintColor="#007AFF"
      colors={['#007AFF']}
    />
  );

  // Erreur sans cache : affiche le message d'erreur + bouton réessayer.
  // PTR disponible pour retenter sans passer par le bouton.
  if (error !== null && missions.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.fillContainer} refreshControl={refreshControl}>
        <ErrorState errorMessage={error} onRetry={onRetry} />
      </ScrollView>
    );
  }

  // Vide (fetch réussi, 0 missions) : affiche le CTA.
  // PTR disponible pour vérifier s'il y a de nouvelles missions.
  if (missions.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.fillContainer} refreshControl={refreshControl}>
        <EmptyState onCreatePress={onCreatePress} />
      </ScrollView>
    );
  }

  // Données : liste complète avec PTR (spinner natif, données actuelles visibles).
  return (
    <ScrollView contentContainerStyle={styles.container} refreshControl={refreshControl}>
      {missions.map(mission => (
        <MissionCard key={mission.id} mission={mission} />
      ))}
    </ScrollView>
  );
}

// -- MissionCard — composant fils pour une ligne mission ---------------------

function MissionCard({ mission }: { mission: MissionDTO }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{mission.targetProduct}</Text>
        <Text style={styles.cardStatus}>{mission.status}</Text>
      </View>
      <Text style={styles.cardDestination}>
        {mission.origin} → {mission.destination}
      </Text>
      <View style={styles.cardFooter}>
        <Text style={styles.cardBudget}>{(mission.budgetCents / 100).toFixed(2)} €</Text>
        <Text style={styles.cardVersion}>v{mission.version}</Text>
      </View>
    </View>
  );
}

// -- Styles ------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    padding: 16,
  },
  fillContainer: {
    flexGrow: 1,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e5e5',
    padding: 16,
    marginBottom: 12,
    gap: 8,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  cardTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#222',
  },
  cardStatus: {
    fontSize: 12,
    fontWeight: '500',
    color: '#666',
    backgroundColor: '#f0f0f0',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  cardDestination: {
    fontSize: 13,
    color: '#666',
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  cardBudget: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
  cardVersion: {
    fontSize: 12,
    color: '#999',
  },
});
