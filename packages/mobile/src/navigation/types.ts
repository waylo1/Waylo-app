// Types de navigation — un seul ParamList partagé par les deux stacks (Auth/App).
// React Navigation v7 : `RootStackParamList` est consommé par `createNativeStackNavigator`
// et `useNavigation` pour typer les `navigation.navigate(...)`.

import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStackParamList = {
  Login: undefined;
  Dashboard: undefined;
};

export type RootStackScreenProps<RouteName extends keyof RootStackParamList> =
  NativeStackScreenProps<RootStackParamList, RouteName>;
