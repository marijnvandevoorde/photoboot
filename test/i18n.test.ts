import { describe, expect, it } from 'vitest';
import { STRINGS, translator } from '../src/i18n.ts';

describe('translator', () => {
  it('uses the chosen language', () => {
    expect(translator({ language: 'nl' })('takePhoto')).toBe('Neem foto');
  });

  it('falls back to English for an unknown language', () => {
    expect(translator({ language: 'xx' })('takePhoto')).toBe('Take photo');
  });

  it('prefers a non-empty override', () => {
    const t = translator({ language: 'en', texts: { takePhoto: 'Cheese!', smile: '   ' } });
    expect(t('takePhoto')).toBe('Cheese!');
    expect(t('smile')).toBe('Smile!');
  });

  it('fills placeholders', () => {
    expect(translator({ language: 'fr' })('photoOf', { n: 2, total: 3 })).toBe('Photo 2 sur 3');
  });

  it('returns the key for unknown strings', () => {
    expect(translator({})('nope')).toBe('nope');
  });

  it('has every English string in every language', () => {
    for (const [lang, table] of Object.entries(STRINGS)) {
      expect(Object.keys(table).sort(), lang).toEqual(Object.keys(STRINGS.en).sort());
    }
  });
});
