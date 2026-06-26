// Détection de l'état réseau via @react-native-community/netinfo.
//
// Retourne isOnline=true par défaut (optimiste) jusqu'à la première notification
// du système — évite un flash "hors-ligne" au boot si l'évaluation n'est pas encore
// arrivée. isKnown passe à true dès que NetInfo a confirmé l'état.
//
// Android : ACCESS_NETWORK_STATE est déclaré automatiquement par le plugin Expo
// de @react-native-community/netinfo — aucun ajout manuel dans AndroidManifest.xml.

import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

export interface NetworkStatus {
  /** true = connecté (ou état inconnu — optimiste). false = hors ligne confirmé. */
  readonly isOnline: boolean;
  /** false jusqu'à la première réponse NetInfo (boot). */
  readonly isKnown: boolean;
}

export function useNetworkStatus(): NetworkStatus {
  const [isOnline, setIsOnline] = useState(true);
  const [isKnown, setIsKnown] = useState(false);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsOnline(state.isConnected !== false);
      setIsKnown(true);
    });
    return unsubscribe;
  }, []);

  return { isOnline, isKnown };
}
