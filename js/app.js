import { fetchAnalysis, reverseGeocode } from './api.js';

const { jsPDF } = window.jspdf;

// ── Tile layers ───────────────────────────────────────────────────────────────
const tileLayers = {
  dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution:'©OpenStreetMap ©Carto', maxZoom:20 }),
  street: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'©OpenStreetMap contributors', maxZoom:19 }),
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution:'Tiles ©Esri', maxZoom:19 }),
};

const map = L.map('map', { zoomControl:false }).setView([41.12, 16.86], 15);
tileLayers.dark.addTo(map);
L.control.zoom({ position:'topright' }).addTo(map);
let activeLayer = 'dark';

document.querySelectorAll('.map-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const layer = btn.dataset.layer;
    if (layer === activeLayer) return;
    map.removeLayer(tileLayers[activeLayer]);
    tileLayers[layer].addTo(map);
    tileLayers[layer].bringToBack();
    activeLayer = layer;
    document.querySelectorAll('.map-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ── Draw ──────────────────────────────────────────────────────────────────────
const drawnItems = new L.FeatureGroup().addTo(map);
const drawControl = new L.Control.Draw({
  position:'topleft',
  draw: {
    polygon: { shapeOptions:{ color:'#7ec87e', fillColor:'#7ec87e', fillOpacity:0.15, weight:2 }, showArea:true },
    polyline:false, rectangle:false, circle:false, circlemarker:false, marker:false,
  },
  edit: { featureGroup:drawnItems },
});
map.addControl(drawControl);

let currentPolygon = null;
let currentGeoJSON = null;
let lastResults    = null;
let detectedPlace  = '';

const btnAnalyze    = document.getElementById('btn-analyze');
const btnClear      = document.getElementById('btn-clear');
const btnPdf        = document.getElementById('btn-pdf');
const results       = document.getElementById('results');
const loading       = document.getElementById('loading');
const loadingText   = document.getElementById('loading-text');
const errorBox      = document.getElementById('error');
const areaBadge     = document.getElementById('area-badge');
const climateToast  = document.getElementById('climate-toast');
const climateSelect = document.getElementById('climate-zone');
const autoBadge     = document.getElementById('auto-badge');

// ── Auto climate zone ─────────────────────────────────────────────────────────
async function detectClimateZone(latlng) {
  try {
    const data = await reverseGeocode(latlng.lat, latlng.lng);
    const addr   = data.address || {};
    const region = (addr.state || addr.region || '').toLowerCase();

    const alpineKw = ['valle d\'aosta','trentino','alto adige','südtirol','friuli'];
    const medKw    = ['sicilia','sardegna','calabria','campania','puglia','basilicata','lazio','abruzzo','molise','liguria'];

    let zone = 'continental', zoneName = 'Continentale 🏙';
    if (alpineKw.some(k => region.includes(k)))  { zone = 'alpine';         zoneName = 'Alpina 🏔'; }
    else if (medKw.some(k => region.includes(k))) { zone = 'mediterranean';  zoneName = 'Mediterranea 🌊'; }

    climateSelect.value = zone;
    climateSelect.classList.add('auto-detected');
    autoBadge.style.display = 'inline-block';

    detectedPlace = addr.city || addr.town || addr.county || addr.state || '';
    showToast(`📍 ${detectedPlace} → Zona ${zoneName} rilevata automaticamente`);
  } catch(e) { console.warn('Geocoding failed:', e); }
}

function showToast(msg) {
  climateToast.textContent = msg;
  climateToast.classList.add('visible');
  setTimeout(() => climateToast.classList.remove('visible'), 4500);
}

// ── Draw events ───────────────────────────────────────────────────────────────
map.on(L.Draw.Event.CREATED, async (e) => {
  if (currentPolygon) drawnItems.removeLayer(currentPolygon);
  currentPolygon = e.layer;
  drawnItems.addLayer(currentPolygon);
  currentGeoJSON = currentPolygon.toGeoJSON().geometry;

  const area = L.GeometryUtil.geodesicArea(currentPolygon.getLatLngs()[0]);
  areaBadge.innerHTML = `Area: <strong>${formatArea(area)}</strong>`;
  areaBadge.classList.add('visible');

  btnAnalyze.disabled = false;
  hideError();
  results.classList.remove('visible');
  btnPdf.classList.remove('visible');

  await detectClimateZone(currentPolygon.getBounds().getCenter());
});

map.on(L.Draw.Event.DELETED, resetState);
btnClear.addEventListener('click', () => { drawnItems.clearLayers(); resetState(); hideError(); });

function resetState() {
  currentPolygon = null; currentGeoJSON = null; lastResults = null;
  btnAnalyze.disabled = true;
  areaBadge.classList.remove('visible');
  results.classList.remove('visible');
  btnPdf.classList.remove('visible');
  climateSelect.classList.remove('auto-detected');
  autoBadge.style.display = 'none';
}

climateSelect.addEventListener('change', () => {
  climateSelect.classList.remove('auto-detected');
  autoBadge.style.display = 'none';
});

// ── Analyze ───────────────────────────────────────────────────────────────────
btnAnalyze.addEventListener('click', async () => {
  if (!currentGeoJSON) return;
  showLoading(true, 'Recupero dati Sentinel-2…'); hideError(); results.classList.remove('visible'); btnPdf.classList.remove('visible');

  try {
    lastResults = await fetchAnalysis({
      geometry: currentGeoJSON,
      date_from: document.getElementById('date-from').value,
      date_to:   document.getElementById('date-to').value,
      cloud_coverage_max: parseFloat(document.getElementById('cloud-max').value),
      climate_zone: climateSelect.value,
    });
    renderResults(lastResults);
    btnPdf.classList.add('visible');
  } catch(e) {
    showError(e.message);
  } finally {
    showLoading(false);
  }
});

// ── Render results ────────────────────────────────────────────────────────────
function renderResults({ albedo, thermal, energy, warnings }) {
  results.innerHTML = `
    <div class="results-title">Risultati analisi</div>
    <div class="savings-hero">
      <div class="savings-label">Risparmio annuo stimato</div>
      <div class="savings-amount">${formatEur(energy.annual_savings_eur)}</div>
      <div class="savings-sub">${energy.annual_cooling_savings_kwh} kWh/anno risparmiati</div>
    </div>
    <div class="result-card">
      <div class="card-header">🛰 Albedo — Sentinel-2</div>
      <div class="metric-row"><span class="metric-label">Albedo attuale</span><span class="metric-value">${(albedo.current_albedo*100).toFixed(1)}%</span></div>
      <div class="metric-row"><span class="metric-label">Albedo cool roof</span><span class="metric-value highlight">${(albedo.target_albedo*100).toFixed(1)}%</span></div>
      <div class="divider"></div>
      <div class="metric-row"><span class="metric-label">Area analizzata</span><span class="metric-value">${formatArea(albedo.area_m2)}</span></div>
      <div class="metric-row"><span class="metric-label">Scena Sentinel</span><span class="metric-value">${albedo.sentinel_scene_date}</span></div>
      <div class="metric-row"><span class="metric-label">Copertura nuvolosa</span><span class="metric-value">${albedo.cloud_coverage_pct.toFixed(1)}%</span></div>
    </div>
    <div class="result-card">
      <div class="card-header">🌡 Riduzione temperatura</div>
      <div class="metric-row"><span class="metric-label">Superficie tetto</span><span class="metric-value highlight">−${thermal.surface_temp_reduction_c} °C</span></div>
      <div class="metric-row"><span class="metric-label">Temperatura interna</span><span class="metric-value">−${thermal.indoor_temp_reduction_c} °C</span></div>
      <div class="metric-row"><span class="metric-label">Aria ambiente (UHI)</span><span class="metric-value">−${thermal.ambient_temp_reduction_c} °C</span></div>
    </div>
    <div class="result-card">
    <div class="card-header">⚡ Impatto energetico</div>
<div class="metric-row">
<span class="metric-label">Prezzo energia</span>
<span class="metric-value" title="Fonte: ${energy.price_source} — ${energy.price_last_updated}">
  ${(energy.electricity_price_eur_kwh * 100).toFixed(2)} c€/kWh
  ${energy.price_source === 'gme_api' ? '<span style="color:var(--accent);font-size:10px;margin-left:4px">● LIVE</span>' : ''}
</span>
</div>
<div class="divider"></div>
<div class="metric-row"><span class="metric-label">CO₂ evitata</span><span class="metric-value">${energy.co2_avoided_kg_year} kg/anno</span></div>
      ${energy.payback_years ? `<div class="metric-row"><span class="metric-label">Payback period</span><span class="metric-value highlight">${energy.payback_years} anni</span></div>` : ''}
    </div>
    ${warnings.map(w => `<div class="warning-badge">⚠️ ${w}</div>`).join('')}
  `;
  requestAnimationFrame(() => results.classList.add('visible'));
}

// ── PDF Modal ─────────────────────────────────────────────────────────────────
const pdfModal = document.getElementById('pdf-modal');
btnPdf.addEventListener('click', () => {
  document.getElementById('pdf-building').value = detectedPlace ? `Edificio - ${detectedPlace}` : '';
  pdfModal.classList.add('visible');
});
document.getElementById('btn-pdf-cancel').addEventListener('click', () => pdfModal.classList.remove('visible'));

document.getElementById('btn-pdf-generate').addEventListener('click', async () => {
  pdfModal.classList.remove('visible');
  await generatePDF(
    document.getElementById('pdf-building').value || 'Edificio analizzato',
    document.getElementById('pdf-client').value || ''
  );
});

// ── PDF Generation ────────────────────────────────────────────────────────────
async function generatePDF(buildingName, clientName) {
  showLoading(true, 'Generazione PDF…');

  try {
    // 1. Screenshot mappa
    const mapEl = document.getElementById('map');
    const mapCanvas = await html2canvas(mapEl, { useCORS:true, allowTaint:true, scale:1.5 });
    const mapImg = mapCanvas.toDataURL('image/jpeg', 0.85);

    const doc = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });
    const W = 210, H = 297;
    const margin = 14;
    const contentW = W - margin * 2;
    let y = 0;

    // ── Cover / Header ────────────────────────────────────────────────────────
    // Green top bar
    doc.setFillColor(126, 200, 126);
    doc.rect(0, 0, W, 28, 'F');

    // Logo text
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(13, 15, 14);
    doc.text('CoolRoof', margin, 17);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(20, 40, 20);
    doc.text('Analisi albedo e risparmio energetico', margin + 42, 17);

    // Date top right
    doc.setFontSize(8);
    doc.setTextColor(20, 40, 20);
    doc.text(new Date().toLocaleDateString('it-IT', { day:'2-digit', month:'long', year:'numeric' }), W - margin, 17, { align:'right' });

    y = 36;

    // ── Building info ─────────────────────────────────────────────────────────
    doc.setFillColor(26, 23, 26);
    doc.roundedRect(margin, y, contentW, clientName ? 22 : 16, 3, 3, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(232, 237, 232);
    doc.text(buildingName, margin + 6, y + 9);

    if (clientName) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(138, 149, 138);
      doc.text(`Committente: ${clientName}`, margin + 6, y + 17);
    }

    y += (clientName ? 22 : 16) + 8;

    // ── Map screenshot ────────────────────────────────────────────────────────
    const mapH = 70;
    doc.setDrawColor(38, 41, 38);
    doc.setLineWidth(0.3);
    doc.roundedRect(margin, y, contentW, mapH, 3, 3, 'S');
    doc.addImage(mapImg, 'JPEG', margin + 0.3, y + 0.3, contentW - 0.6, mapH - 0.6, '', 'FAST');

    // Map label overlay
    doc.setFillColor(13, 15, 14, 0.7);
    doc.setFillColor(13, 15, 14);
    doc.roundedRect(margin + 3, y + mapH - 9, 50, 7, 2, 2, 'F');
    doc.setFontSize(7);
    doc.setTextColor(138, 149, 138);
    doc.text('Area selezionata (poligono verde)', margin + 5, y + mapH - 4.5);

    y += mapH + 8;

    // ── Results in 3 columns ──────────────────────────────────────────────────
    const { albedo, thermal, energy } = lastResults;
    const colW = (contentW - 8) / 3;

    const cards = [
      {
        title: 'ALBEDO  —  SENTINEL-2',
        color: [126, 200, 126],
        rows: [
          ['Albedo attuale',   `${(albedo.current_albedo*100).toFixed(1)}%`],
          ['Albedo cool roof', `${(albedo.target_albedo*100).toFixed(1)}%`],
          ['Area analizzata',  formatArea(albedo.area_m2)],
          ['Scena Sentinel',   albedo.sentinel_scene_date],
          ['Nuvole',           `${albedo.cloud_coverage_pct.toFixed(1)}%`],
        ],
      },
      {
        title: 'RIDUZIONE TEMPERATURA',
        color: [126, 200, 126],
        rows: [
          ['Superficie tetto',  `-${thermal.surface_temp_reduction_c} \u00b0C`],
          ['Temperatura interna',`-${thermal.indoor_temp_reduction_c} \u00b0C`],
          ['Aria ambiente',     `-${thermal.ambient_temp_reduction_c} \u00b0C`],
        ],
      },
      {
        title: 'IMPATTO ENERGETICO',
        color: [126, 200, 126],
        rows: [
          ['Risparmio annuo',   formatEur(energy.annual_savings_eur)],
          ['kWh risparmiati',   `${energy.annual_cooling_savings_kwh} kWh/a`],
          ['CO2 evitata',       `${energy.co2_avoided_kg_year} kg/a`],
          ...(energy.payback_years ? [['Payback period', `${energy.payback_years} anni`]] : []),
        ],
      },
    ];

    cards.forEach((card, i) => {
      const x = margin + i * (colW + 4);
      const cardH = 10 + card.rows.length * 11 + 4;

      // Card background
      doc.setFillColor(27, 30, 27);
      doc.roundedRect(x, y, colW, cardH, 3, 3, 'F');

      // Card title
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.5);
      doc.setTextColor(...card.color);
      doc.text(card.title, x + 5, y + 7);

      // Rows
      card.rows.forEach((row, ri) => {
        const ry = y + 13 + ri * 11;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(138, 149, 138);
        doc.text(row[0], x + 5, ry);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(232, 237, 232);
        doc.text(row[1], x + colW - 5, ry, { align:'right' });

        // Thin separator
        if (ri < card.rows.length - 1) {
          doc.setDrawColor(38, 41, 38);
          doc.setLineWidth(0.2);
          doc.line(x + 4, ry + 3, x + colW - 4, ry + 3);
        }
      });
    });

    const maxCardH = Math.max(...cards.map(c => 10 + c.rows.length * 11 + 4));
    y += maxCardH + 8;

    // ── Savings hero ──────────────────────────────────────────────────────────
    doc.setFillColor(20, 40, 20);
    doc.roundedRect(margin, y, contentW, 28, 4, 4, 'F');
    doc.setDrawColor(42, 74, 42);
    doc.setLineWidth(0.4);
    doc.roundedRect(margin, y, contentW, 28, 4, 4, 'S');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(126, 200, 126);
    doc.text('RISPARMIO ANNUO STIMATO', W / 2, y + 8, { align:'center' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(26);
    doc.setTextColor(184, 240, 184);
    doc.text(formatEur(energy.annual_savings_eur), W / 2, y + 21, { align:'center' });

    y += 36;

    // ── Zone & methodology note ───────────────────────────────────────────────
    const zoneLabels = { mediterranean:'Mediterranea', continental:'Continentale', alpine:'Alpina' };
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(80, 90, 80);
    doc.text(
      `Zona climatica: ${zoneLabels[climateSelect.value]}  •  Periodo analisi: ${document.getElementById('date-from').value} → ${document.getElementById('date-to').value}  •  Albedo: formula Liang 2001 (Sentinel-2 L2A)`,
      W / 2, y, { align:'center' }
    );
    y += 5;
    doc.text('Risparmio calcolato con metodo EN ISO 13790 semplificato. Stima orientativa, non sostituisce una diagnosi energetica professionale.', W / 2, y, { align:'center' });

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.setFillColor(20, 23, 20);
    doc.rect(0, H - 10, W, 10, 'F');
    doc.setFontSize(7);
    doc.setTextColor(80, 90, 80);
    doc.text('CoolRoof Analyzer  •  Powered by Sentinel-2 / Sentinel Hub', margin, H - 4);
    doc.text(`Generato il ${new Date().toLocaleString('it-IT')}`, W - margin, H - 4, { align:'right' });

    // ── Save ──────────────────────────────────────────────────────────────────
    const filename = `coolroof-report-${buildingName.replace(/[^a-z0-9]/gi,'_').toLowerCase()}-${new Date().toISOString().slice(0,10)}.pdf`;
    doc.save(filename);

  } catch(err) {
    showError('Errore generazione PDF: ' + err.message);
    console.error(err);
  } finally {
    showLoading(false);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showLoading(v, msg) { loading.classList.toggle('visible', v); if (msg) loadingText.textContent = msg; btnAnalyze.disabled = v; }
function showError(msg) { errorBox.textContent = '⚠️ ' + msg; errorBox.classList.add('visible'); }
function hideError() { errorBox.classList.remove('visible'); }
function formatEur(v) { return new Intl.NumberFormat('it-IT', { style:'currency', currency:'EUR', maximumFractionDigits:0 }).format(v); }
function formatArea(m2) { return m2 >= 10000 ? (m2/10000).toFixed(2)+' ha' : Math.round(m2).toLocaleString('it-IT')+' m²'; }
