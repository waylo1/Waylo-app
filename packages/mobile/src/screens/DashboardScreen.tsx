// DashboardScreen — écran post-login. Affiche l'utilisateur courant (UserDTO
// depuis le store, typé via @waylo/shared) et permet le logout (clearSession
// → RootNavigator swap vers le stack Auth).
//
// Le logout n'appelle PAS `navigation.navigate('Login')` : c'est le navigateur
// qui réagit au changement d'état d'auth, garantissant un seul re-render
// (pas de race entre purge SecureStore et transition d'écran).

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAuthStore } from '../auth/auth.store';

export default function DashboardScreen() {
  const user = useAuthStore((s) => s.session?.user ?? null);
  const clearSession = useAuthStore((s) => s.clearSession);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Waylo — Tableau de bord</Text>
      {user !== null && (
        <View style={styles.userBox}>
          <Text style={styles.userLabel}>Connecté en tant que</Text>
          <Text style={styles.userEmail}>{user.email}</Text>
          <Text style={styles.userMeta}>KYC : {user.kycStatus}</Text>
        </View>
      )}

      <TouchableOpacity
        style={styles.logoutButton}
        onPress={() => {
          void clearSession();
        }}
        accessibilityRole="button"
      >
        <Text style={styles.logoutText}>Se déconnecter</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 16,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 24,
  },
  userBox: {
    borderWidth: 1,
    borderColor: '#e5e5e5',
    borderRadius: 12,
    padding: 16,
    gap: 4,
  },
  userLabel: {
    color: '#666',
    fontSize: 12,
    textTransform: 'uppercase',
  },
  userEmail: {
    fontSize: 18,
    fontWeight: '500',
  },
  userMeta: {
    color: '#444',
    fontSize: 14,
  },
  logoutButton: {
    marginTop: 16,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#c00',
    alignItems: 'center',
  },
  logoutText: {
    color: '#c00',
    fontSize: 16,
    fontWeight: '600',
  },
});
