// Hook pour l'animation de pulse des skeletons — Animated natif RN.
// Pulse infini : opacité 1 → 0.5 → 1, durée 1.5s total (750ms chaque direction).

import { useEffect, useMemo } from 'react';
import { Animated } from 'react-native';

export function useSkeleton(): Animated.Value {
  const pulseAnim = useMemo(() => new Animated.Value(1), []);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.5,
          duration: 750,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 750,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  return pulseAnim;
}
