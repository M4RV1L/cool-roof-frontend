export const API_BASE = 'https://cool-roof-production.up.railway.app/api/v1';

export async function fetchAnalysis(payload) {
  const res = await fetch(`${API_BASE}/analysis/cool-roof`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const e = await res.json();
    throw new Error(e.detail || `Errore ${res.status}`);
  }
  return await res.json();
}

export async function reverseGeocode(lat, lng) {
  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, {
    headers: { 'Accept-Language': 'it' }
  });
  return await res.json();
}
