// ErrorState — affiché quand le fetch échoue et aucune donnée en cache.
// Message clair + bouton "Réessayer".

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export interface ErrorStateProps {
  readonly errorMessage?: string;
  readonly onRetry: () => void;
}

export function ErrorState({ errorMessage, onRetry }: ErrorStateProps) {
  const message = errorMessage ?? 'Impossible de charger vos missions. Vérifiez votre connexion.';

  return (
    <View style={styles.container}>
      <View style={styles.iconBox}>
        <Text style={styles.icon}>⚠️</Text>
      </View>
      <Text style={styles.title}>Erreur de chargement</Text>
      <Text style={styles.message}>{message}</Text>
      <TouchableOpacity style={styles.button} onPress={onRetry} accessibilityRole="button">
        <Text style={styles.buttonText}>Réessayer</Text>
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
    backgroundColor: '#ffe5e5',
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
    color: '#c00',
  },
  message: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
  },
  button: {
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#c00',
    alignItems: 'center',
  },
  buttonText: {
    color: '#c00',
    fontSize: 16,
    fontWeight: '600',
  },
});
