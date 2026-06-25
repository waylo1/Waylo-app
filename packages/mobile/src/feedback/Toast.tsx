// Toast — bannière animée slide-from-top, s'auto-ferme après 3s.
// Montée UNE FOIS dans l'arbre (racine de l'app ou écran principal).
// Lit son état depuis useToastStore : aucune prop requise.

import { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useToastStore } from './toast.store';
import type { ToastType } from './toast.store';

const ANIMATION_DURATION_IN = 300;
const ANIMATION_DURATION_OUT = 250;
const AUTO_DISMISS_MS = 3000;
const OFFSCREEN_Y = -90;

function bgColor(type: ToastType): string {
  switch (type) {
    case 'error':
      return '#c00';
    case 'success':
      return '#1a7f1e';
    case 'info':
      return '#333';
  }
}

export function Toast() {
  const visible = useToastStore((s) => s.visible);
  const message = useToastStore((s) => s.message);
  const type = useToastStore((s) => s.type);
  const hideToast = useToastStore((s) => s.hideToast);

  // Animated values via useMemo — jamais .current pendant le rendu (lint react-hooks/refs).
  const translateY = useMemo(() => new Animated.Value(OFFSCREEN_Y), []);
  const opacity = useMemo(() => new Animated.Value(0), []);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }

    // Annule le timer précédent si on re-montre un toast avant dismissal.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }

    // Réinitialise avant d'animer (cas de re-show sans remontage).
    translateY.setValue(OFFSCREEN_Y);
    opacity.setValue(0);

    Animated.parallel([
      Animated.timing(translateY, { toValue: 0, duration: ANIMATION_DURATION_IN, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: ANIMATION_DURATION_IN, useNativeDriver: true }),
    ]).start();

    timerRef.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(translateY, { toValue: OFFSCREEN_Y, duration: ANIMATION_DURATION_OUT, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: ANIMATION_DURATION_OUT, useNativeDriver: true }),
      ]).start(() => hideToast());
    }, AUTO_DISMISS_MS);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [visible, message, type, translateY, opacity, hideToast]);

  if (!visible) {
    return null;
  }

  return (
    <Animated.View
      style={[styles.container, { backgroundColor: bgColor(type), transform: [{ translateY }], opacity }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.message} numberOfLines={2}>{message}</Text>
      <TouchableOpacity
        onPress={hideToast}
        style={styles.closeButton}
        accessibilityRole="button"
        accessibilityLabel="Fermer la notification"
      >
        <Text style={styles.closeText}>×</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 48, // safe area approximation
    paddingBottom: 12,
    paddingHorizontal: 16,
    zIndex: 9999,
    gap: 12,
  },
  message: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  closeButton: {
    padding: 4,
  },
  closeText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 20,
  },
});
