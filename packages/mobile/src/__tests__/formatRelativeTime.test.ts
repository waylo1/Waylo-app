import { formatRelativeTime } from '../utils/formatRelativeTime';

const SEC = 1000;
const MIN = 60 * SEC;
const H = 60 * MIN;
const D = 24 * H;

describe('formatRelativeTime', () => {
  it('< 60s → quelques secondes', () => {
    expect(formatRelativeTime(1000, 1000 + 59 * SEC)).toBe('il y a quelques secondes');
  });

  it('0s (même instant) → quelques secondes', () => {
    expect(formatRelativeTime(1000, 1000)).toBe('il y a quelques secondes');
  });

  it('1 min → il y a 1 min', () => {
    expect(formatRelativeTime(0, MIN)).toBe('il y a 1 min');
  });

  it('59 min → il y a 59 min', () => {
    expect(formatRelativeTime(0, 59 * MIN)).toBe('il y a 59 min');
  });

  it('1 h → il y a 1 h', () => {
    expect(formatRelativeTime(0, H)).toBe('il y a 1 h');
  });

  it('23 h → il y a 23 h', () => {
    expect(formatRelativeTime(0, 23 * H)).toBe('il y a 23 h');
  });

  it('1 jour → il y a 1 j', () => {
    expect(formatRelativeTime(0, D)).toBe('il y a 1 j');
  });

  it('3 jours → il y a 3 j', () => {
    expect(formatRelativeTime(0, 3 * D)).toBe('il y a 3 j');
  });

  it('nowMs < epochMs (horloge avancée) → quelques secondes (diff négatif clampé)', () => {
    // Horloge client légèrement en avance sur le serveur.
    expect(formatRelativeTime(5000, 1000)).toBe('il y a quelques secondes');
  });
});
