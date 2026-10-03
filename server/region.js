// Durable Object region for a new room (no Cloudflare APIs here: takes the request.cf object as plain data).
// hint=auto (new clients, 03.10): the room goes near whoever opens it — by the country of their request (request.cf).
// Russia/CIS/Eastern Europe → eeur, Western Europe → weur, South-East Asia → apac-se, Japan/Korea → apac-ne,
// US/Canada → wnam or enam by longitude; anywhere else → no hint (the object is created near the edge that took the
// request, i.e. near the creator anyway). Old clients keep sending apac-se and get exactly what they got before.
const EEUR = new Set(['RU', 'BY', 'UA', 'MD', 'KZ', 'UZ', 'KG', 'TJ', 'TM', 'AM', 'AZ', 'GE', 'PL', 'LT', 'LV', 'EE',
  'FI', 'RO', 'BG', 'HU', 'CZ', 'SK', 'RS', 'BA', 'ME', 'MK', 'AL', 'XK', 'GR', 'TR', 'CY']);
const APAC_SE = new Set(['ID', 'SG', 'MY', 'TH', 'VN', 'PH', 'KH', 'LA', 'MM', 'BN', 'TL']);
const APAC_NE = new Set(['JP', 'KR', 'TW']);
export function autoHint(cf) {
  const c = String((cf && cf.country) || '').toUpperCase();
  if (EEUR.has(c)) return 'eeur';
  if (APAC_SE.has(c)) return 'apac-se';
  if (APAC_NE.has(c)) return 'apac-ne';
  if (c === 'US' || c === 'CA') return Number(cf.longitude) < -100 ? 'wnam' : 'enam';
  if (cf && cf.continent === 'EU') return 'weur';
  return null;
}
