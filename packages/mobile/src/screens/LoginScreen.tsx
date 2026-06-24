// LoginScreen — appel d'auth RÉEL (MOB-05). Plus aucune fabrication locale de
// SessionDTO : token + user proviennent EXCLUSIVEMENT du backend.
//
// Flow :
// 1. POST /api/auth/login (LoginRequest) → LoginResponse { token }.
// 2. GET  /api/auth/me avec ce token (header explicite — le store n'a pas encore
//    la session, donc l'intercepteur ne l'injecterait pas) → UserDTO.
// 3. setSession({ token, claims: { sub: user.id }, user }) — RootNavigator
//    swap automatique vers Dashboard via le re-render React.
//
// Note `claims.sub` : la backend signe `{ sub: user.id }` (cf. auth.route.ts:99) ;
// `user.id` IS la valeur de `sub`. Pas besoin de décoder le JWT côté client.
//
// Gestion d'erreurs (typées via ApiError) :
// - 401 + code INVALID_CREDENTIALS → message d'identifiants.
// - 429 RATE_LIMITED                → message dédié.
// - NETWORK_ERROR                   → message dédié.
// - autre                           → message générique avec le code (pas le token).
//
// Sécurité : aucun log du token (jamais affiché, jamais inclus dans une erreur).

import { useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { LoginRequest, SessionDTO } from '@waylo/shared';
import { useAuthStore } from '../auth/auth.store';
import { getMe, login as loginApi } from '../api/auth.api';
import { toApiError } from '../api/errors';

function formatError(code: string): string {
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return 'Identifiants invalides.';
    case 'RATE_LIMITED':
      return 'Trop de tentatives. Réessayez dans un instant.';
    case 'NETWORK_ERROR':
      return 'Connexion impossible. Vérifiez votre réseau.';
    case 'INVALID_INPUT':
      return 'Email ou mot de passe au format invalide.';
    default:
      return `Erreur de connexion (${code}).`;
  }
}

export default function LoginScreen() {
  const setSession = useAuthStore((s) => s.setSession);
  const [credentials, setCredentials] = useState<LoginRequest>({
    email: '',
    password: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    credentials.email.length > 0 &&
    credentials.password.length > 0 &&
    !submitting;

  const onSubmit = async () => {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { token } = await loginApi(credentials);
      const user = await getMe(token);
      const session: SessionDTO = {
        token,
        claims: { sub: user.id },
        user,
      };
      await setSession(session);
      // Pas de `navigation.navigate('Dashboard')` : le RootNavigator route sur
      // l'état d'auth — éviter le double-routing (race).
    } catch (e) {
      const apiError = toApiError(e);
      setError(formatError(apiError.code));
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Waylo — Connexion</Text>

      <TextInput
        style={styles.input}
        placeholder="Email"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        value={credentials.email}
        onChangeText={(email) =>
          setCredentials((prev) => ({ ...prev, email }))
        }
        editable={!submitting}
      />

      <TextInput
        style={styles.input}
        placeholder="Mot de passe"
        secureTextEntry
        autoComplete="password"
        textContentType="password"
        value={credentials.password}
        onChangeText={(password) =>
          setCredentials((prev) => ({ ...prev, password }))
        }
        editable={!submitting}
      />

      {error !== null && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity
        style={[styles.button, !canSubmit && styles.buttonDisabled]}
        onPress={onSubmit}
        disabled={!canSubmit}
        accessibilityRole="button"
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Se connecter</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 12,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 16,
    textAlign: 'center',
  },
  input: {
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#111',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: '#c00',
    textAlign: 'center',
  },
});
