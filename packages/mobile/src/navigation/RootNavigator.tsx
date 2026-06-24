// RootNavigator — gating conditionnel sur l'état d'auth hydraté (zustand).
//
// Pattern officiel React Navigation v7 « Authentication flows »
// (https://reactnavigation.org/docs/auth-flow) : on monte des écrans DIFFÉRENTS
// selon l'état d'auth, plutôt qu'un seul stack avec navigation impérative. Cela
// garantit :
// - aucun flash de mauvais écran (Login ne se monte jamais si la session est valide),
// - aucune race boot/nav (la transition se fait par re-render React, pas par
//   `navigation.navigate(...)` dispatché en parallèle de la purge SecureStore).
//
// Le Splash (cf. App.tsx) bloque le rendu de ce navigateur tant que `status ===
// 'loading'` — donc à l'entrée ici, `status` vaut TOUJOURS 'authenticated' ou
// 'unauthenticated'. La présence d'une session détermine quel stack monter.

import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuthStore } from '../auth/auth.store';
import LoginScreen from '../screens/LoginScreen';
import DashboardScreen from '../screens/DashboardScreen';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
  const session = useAuthStore((s) => s.session);

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {session === null ? (
          <Stack.Screen name="Login" component={LoginScreen} />
        ) : (
          <Stack.Screen name="Dashboard" component={DashboardScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
