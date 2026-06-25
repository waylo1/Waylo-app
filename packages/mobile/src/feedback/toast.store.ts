// Toast global — état minimal Zustand, sans dépendance supplémentaire.

import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'info';

interface ToastState {
  readonly visible: boolean;
  readonly message: string;
  readonly type: ToastType;
}

interface ToastActions {
  showToast: (message: string, type?: ToastType) => void;
  hideToast: () => void;
}

type ToastSlice = ToastState & ToastActions;

export const useToastStore = create<ToastSlice>((set) => ({
  visible: false,
  message: '',
  type: 'info',

  showToast: (message, type = 'info') => {
    set({ visible: true, message, type });
  },
  hideToast: () => {
    set({ visible: false });
  },
}));
