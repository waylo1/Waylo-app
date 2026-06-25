// Suite toast.store — comportement du slice (showToast, hideToast, type).

import { useToastStore } from '../feedback/toast.store';

beforeEach(() => {
  useToastStore.setState({ visible: false, message: '', type: 'info' });
});

describe('showToast', () => {
  it('rend le toast visible avec le message et le type fournis', () => {
    useToastStore.getState().showToast('Erreur de connexion', 'error');

    const state = useToastStore.getState();
    expect(state.visible).toBe(true);
    expect(state.message).toBe('Erreur de connexion');
    expect(state.type).toBe('error');
  });

  it("utilise 'info' comme type par défaut", () => {
    useToastStore.getState().showToast('Information');

    expect(useToastStore.getState().type).toBe('info');
  });

  it('un second showToast remplace le premier (dernier appel gagne)', () => {
    useToastStore.getState().showToast('Premier', 'info');
    useToastStore.getState().showToast('Deuxième', 'error');

    const state = useToastStore.getState();
    expect(state.message).toBe('Deuxième');
    expect(state.type).toBe('error');
    expect(state.visible).toBe(true);
  });
});

describe('hideToast', () => {
  it('passe visible à false', () => {
    useToastStore.getState().showToast('Test', 'success');
    useToastStore.getState().hideToast();

    expect(useToastStore.getState().visible).toBe(false);
  });
});
