// Point d'entrée de l'app — Splash gate AVANT NavigationContainer.
//
// Tant que `hydrate()` n'a pas résolu (`status === 'loading'`), on rend un
// Splash inline (ActivityIndicator + titre). Le NavigationContainer n'est PAS
// monté → aucun flash de Login si la session est en fait valide, aucune race
// boot/nav. Une fois `hydrate` résolu, on monte `RootNavigator` qui choisit
// son écran initial selon la présence d'une session (cf. RootNavigator.tsx).
//
// `hydrate` est single-flight côté store (cf. auth.store.ts) : pas de double
// lecture SecureStore si l'effet est appelé deux fois (StrictMode dev).

import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuthStore } from './src/auth/auth.store';
import RootNavigator from './src/navigation/RootNavigator';

export default function App() {
  const status = useAuthStore((s) => s.status);
  const hydrate = useAuthStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <SafeAreaProvider>
      {status === 'loading' ? <SplashView /> : <RootNavigator />}
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}

function SplashView() {
  return (
    <View style={styles.splash}>
      <Text style={styles.splashTitle}>Waylo</Text>
      <ActivityIndicator />
    </View>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    backgroundColor: '#fff',
  },
  splashTitle: {
    fontSize: 28,
    fontWeight: '600',
  },
});
