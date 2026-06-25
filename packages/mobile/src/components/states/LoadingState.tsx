// LoadingState — affiche N skeletons pendant le chargement initial.
// Utilisé UNIQUEMENT pour le loading initial, pas le refresh (distinction via le store).

import { ScrollView, StyleSheet } from 'react-native';
import { MissionSkeleton } from '../skeletons/MissionSkeleton';

export interface LoadingStateProps {
  readonly count?: number;
}

export function LoadingState({ count = 4 }: LoadingStateProps) {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      {Array.from({ length: count }).map((_, i) => (
        <MissionSkeleton key={i} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
  },
});
