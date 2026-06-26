// MissionSkeleton — placeholder gris reproduisant la structure d'une carte mission.
// Utilise l'animation de pulse via useSkeleton.

import { Animated, StyleSheet, View } from 'react-native';
import { useSkeleton } from '../../hooks/useSkeleton';

export function MissionSkeleton() {
  const opacity = useSkeleton();

  return (
    <View style={styles.card}>
      <Animated.View style={[styles.skeleton, { opacity }]} />
      <View style={styles.content}>
        <Animated.View style={[styles.skeletonLine, { opacity }, { marginBottom: 8 }]} />
        <Animated.View style={[styles.skeletonLine, { opacity }, { width: '80%' }]} />
      </View>
      <View style={styles.footer}>
        <Animated.View style={[styles.skeletonSmall, { opacity }]} />
        <Animated.View style={[styles.skeletonSmall, { opacity }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e5e5',
    padding: 16,
    marginBottom: 12,
    gap: 12,
  },
  skeleton: {
    height: 120,
    backgroundColor: '#ddd',
    borderRadius: 8,
  },
  content: {
    gap: 8,
  },
  skeletonLine: {
    height: 14,
    backgroundColor: '#ddd',
    borderRadius: 4,
  },
  footer: {
    flexDirection: 'row',
    gap: 12,
  },
  skeletonSmall: {
    height: 12,
    width: '30%',
    backgroundColor: '#ddd',
    borderRadius: 4,
  },
});
