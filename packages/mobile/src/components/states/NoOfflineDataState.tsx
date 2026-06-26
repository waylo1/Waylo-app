// État affiché quand l'app est hors-ligne ET que le cache est vide (jamais synchronisé).
// Pas de CTA de création : les actions d'écriture nécessitent une connexion.

import { StyleSheet, Text, View } from 'react-native';

export function NoOfflineDataState() {
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>📵</Text>
      <Text style={styles.title}>Aucune donnée hors-ligne</Text>
      <Text style={styles.subtitle}>
        Reconnectez-vous à Internet pour charger vos missions.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
  },
  icon: {
    fontSize: 48,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: '#222',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    lineHeight: 20,
  },
});
