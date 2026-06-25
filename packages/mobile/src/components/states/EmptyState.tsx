// EmptyState — affiché quand la liste de missions est vide (0 mission, fetch réussi).
// Illustration/texte sympathique + CTA "Créer".

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export interface EmptyStateProps {
  readonly onCreatePress: () => void;
}

export function EmptyState({ onCreatePress }: EmptyStateProps) {
  return (
    <View style={styles.container}>
      <View style={styles.iconBox}>
        <Text style={styles.icon}>📋</Text>
      </View>
      <Text style={styles.title}>Pas encore de missions</Text>
      <Text style={styles.subtitle}>Créez votre première mission pour commencer</Text>
      <TouchableOpacity style={styles.button} onPress={onCreatePress} accessibilityRole="button">
        <Text style={styles.buttonText}>Créer une mission</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 16,
  },
  iconBox: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  icon: {
    fontSize: 40,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    color: '#222',
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
  },
  button: {
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: '#007AFF',
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
