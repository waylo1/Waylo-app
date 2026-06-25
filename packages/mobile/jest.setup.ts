// Global mock — expose-secure-store n'est pas disponible dans Jest (module natif).
// Ce mock en mémoire (Map) remplace les implémentations réelles pour tous les tests.
// Chaque jest.fn() est réinitialisé par jest.clearAllMocks() dans les beforeEach.
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));
