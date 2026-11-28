import { CAT_BREEDS, ZONE_BREEDS, BREEDS_LOOKUP, catArtUrl, isGeneratedArt, localDayNumber, isEasterSeason } from './catData';

test('every breed has a real-photo source and a cartoon fallback', () => {
  expect(CAT_BREEDS.length).toBeGreaterThan(0);
  expect(CAT_BREEDS.filter(b => !b.catApiId && !b.photoTag).map(b => b.name)).toEqual([]);
  expect(CAT_BREEDS.filter(b => !isGeneratedArt(catArtUrl(b.name))).map(b => b.name)).toEqual([]);
});

test('every catch-zone breed exists', () => {
  const missing = Object.values(ZONE_BREEDS).flat().filter(name => !BREEDS_LOOKUP[name]);
  expect(missing).toEqual([]);
});

test('no dog wording in breed names', () => {
  expect(CAT_BREEDS.filter(b => /\b(dog|puppy)\b/i.test(b.name))).toEqual([]);
});

test('daily content changes at local midnight, one step per calendar day', () => {
  const n = localDayNumber(new Date(2026, 2, 28, 0, 5));
  expect(localDayNumber(new Date(2026, 2, 28, 23, 55))).toBe(n);
  expect(localDayNumber(new Date(2026, 2, 29, 0, 5))).toBe(n + 1);
  expect(localDayNumber(new Date(2026, 2, 30, 0, 5))).toBe(n + 2);
});

test('Easter theme follows the real date of Easter', () => {
  // Easter Sunday: 28 Mar 2027, 16 Apr 2028
  expect(isEasterSeason(new Date(2027, 2, 28))).toBe(true);
  expect(isEasterSeason(new Date(2027, 2, 29, 23, 0))).toBe(true);
  expect(isEasterSeason(new Date(2027, 2, 17))).toBe(false);
  expect(isEasterSeason(new Date(2027, 3, 10))).toBe(false);
  expect(isEasterSeason(new Date(2028, 3, 16))).toBe(true);
});
