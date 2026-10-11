/* Carte interactive de Font-Romeu Pyrénées 2000.
 * MapLibre GL (relief 3D, ombrage), maplibre-contour (courbes de niveau),
 * données de la station générées par scripts/build_data.py. */
/* global maplibregl, mlcontour */
(function () {
  'use strict';

  const DATA = window.FONT_ROMEU;
  const loading = document.getElementById('loading');
  if (!DATA || !window.maplibregl || !window.mlcontour) {
    loading.textContent = 'Impossible de charger la carte. Vérifiez votre connexion puis rechargez la page.';
    loading.classList.add('error');
    return;
  }

  // ------------------------------------------------------------------ Constantes
  const DEM_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
  const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
  const ign = (layer, format) =>
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
    `&LAYER=${layer}&STYLE=normal&TILEMATRIXSET=PM&FORMAT=${format}` +
    '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
  const IGN_ATTRIB = '<a href="https://www.ign.fr/" target="_blank" rel="noopener">© IGN – Géoplateforme</a>';

  const HOME = { center: [2.0385, 42.5275], zoom: 13.75, pitch: 58, bearing: -14 };
  const HOME_MOBILE = { center: [2.0395, 42.5262], zoom: 12.75, pitch: 58, bearing: -24 };
  const FLIGHT = { zoom: 15.2, pitch: 63 }; // caméra des descentes / montées virtuelles
  const DEFAULT_EXAGGERATION = 1.5;

  const COLORS = {
    novice: '#1e9a4b',
    easy: '#1b62c9',
    intermediate: '#d7262f',
    advanced: '#16181c',
    expert: '#16181c',
    freeride: '#e07b00',
    unknown: '#8a96a3',
  };
  const DIFFICULTIES = ['novice', 'easy', 'intermediate', 'advanced', 'expert'];
  const DIFF_LABEL = {
    novice: 'Verte', easy: 'Bleue', intermediate: 'Rouge', advanced: 'Noire', expert: 'Noire', unknown: 'Non classée',
  };
  const LIFT_COLOR = '#1e2a38';
  const NORDIC_COLOR = '#2f7f7a';
  const HIKE_COLOR = '#7a52a6';
  const SELECT_COLOR = '#ffb000';

  const BASEMAPS = [
    { id: 'hiver', label: 'Plan des pistes', thumb: 'linear-gradient(135deg,#f6f8fa 0 45%,#b9d1b4 45% 70%,#f6f8fa 70%)' },
    { id: 'ortho', label: 'Satellite IGN', thumb: 'linear-gradient(135deg,#4b5d3a,#7d7a5c 50%,#c9c6bb)' },
    { id: 'plan', label: 'Plan IGN', thumb: 'linear-gradient(135deg,#f3efe6 0 60%,#f7d27a 60% 66%,#cfe3c5 66%)' },
    { id: 'topo', label: 'OpenTopoMap', thumb: 'repeating-radial-gradient(circle at 30% 70%,#e8efd8 0 5px,#c9a77d 5px 6px)' },
  ];

  // Couches de la carte rattachées à chaque option de l'interface
  const LAYER_GROUPS = {
    hiver: ['w-landuse', 'w-rock', 'w-wood', 'w-wood-pattern', 'w-water', 'w-waterway', 'w-track', 'w-road-minor',
      'w-road-major-casing', 'w-road-major', 'w-rail', 'w-building', 'w-road-label'],
    ortho: ['ign-ortho'],
    plan: ['ign-plan'],
    topo: ['otm'],
    hillshade: ['hillshade'],
    contours: ['contour-minor', 'contour-major', 'contour-label'],
    pistes: ['piste-area', 'snowpark-fill', 'snowpark-line', 'piste-casing', 'piste-line', 'piste-label',
      'snowpark-label', 'piste-hit'],
    lifts: ['lift-casing', 'lift-line', 'pylon', 'station', 'lift-label', 'lift-hit'],
    nordic: ['nordic-casing', 'nordic-line', 'nordic-label', 'nordic-hit'],
    hike: ['hike-line', 'hike-label', 'hike-hit'],
    pois: ['poi-icons', 'peak-label', 'pass-label'],
  };
  const HIT_LAYERS = ['lift-hit', 'station', 'poi-icons', 'peak-label', 'pass-label', 'piste-hit', 'nordic-hit', 'hike-hit'];

  // ------------------------------------------------------------------ Outils
  const nf = new Intl.NumberFormat('fr-FR');
  const nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const coord = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const fmtM = (m) => `${nf.format(Math.round(m))} m`;
  const fmtLen = (m) => (m >= 1000 ? `${nf1.format(m / 1000)} km` : fmtM(m));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normalize = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(`font-romeu:${key}`);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`font-romeu:${key}`, JSON.stringify(value)); } catch (e) { /* stockage indisponible */ }
    },
  };

  function liftAbbr(l) {
    switch (l.lift_type) {
      case 'chair_lift': return l.detachable === 'yes' ? 'TSD' : 'TS';
      case 'gondola': return 'TC';
      case 'cable_car': return 'TPH';
      case 'mixed_lift': return 'TCD';
      case 'rope_tow': return 'FIL';
      case 'magic_carpet': return 'TAPIS';
      default: return 'TK';
    }
  }
  function liftKind(l) {
    let s = l.type_label;
    if (l.lift_type === 'chair_lift' && l.detachable === 'yes') s = 'Télésiège débrayable';
    if (l.occupancy) s += ` · ${l.occupancy} places`;
    return s;
  }
  function pisteKind(p) {
    if (p.kind === 'nordic') return `Ski de fond · ${DIFF_LABEL[p.difficulty] ? `piste ${DIFF_LABEL[p.difficulty].toLowerCase()}` : 'piste'}`;
    if (p.kind === 'hike') return 'Itinéraire raquettes / piéton';
    if (p.difficulty === 'unknown') return 'Piste non classée';
    return `Piste ${DIFF_LABEL[p.difficulty].toLowerCase()}`;
  }

  // ------------------------------------------------------------------ Données
  const pisteById = new Map(DATA.pistes.map((p) => [p.gid, p]));
  const liftById = new Map(DATA.lifts.map((l) => [l.id, l]));
  for (const l of DATA.lifts) l.abbr = liftAbbr(l);
  for (const f of DATA.geojson.features) {
    const p = f.properties;
    if (p.kind === 'lift') p.label = `${liftAbbr(p)} ${p.name}`;
    if (p.kind === 'station') p.abbr = liftById.get(p.lift)?.abbr;
  }

  const summary = DATA.meta.summary;
  const prefs = store.get('prefs', {});
  const state = {
    basemap: BASEMAPS.some((b) => b.id === prefs.basemap) ? prefs.basemap : 'hiver',
    toggles: Object.assign(
      { terrain: true, hillshade: true, contours: true, pistes: true, lifts: true, nordic: true, hike: false, pois: true },
      prefs.toggles || {},
    ),
    exaggeration: clamp(Number(prefs.exaggeration) || DEFAULT_EXAGGERATION, 1, 2.5),
    difficulties: new Set(DIFFICULTIES),
    tab: 'pistes',
    sort: 'default',
    query: '',
    selected: null,
  };
  const savePrefs = () => store.set('prefs', { basemap: state.basemap, toggles: state.toggles, exaggeration: state.exaggeration });

  // ------------------------------------------------------------------ Relief
  const demSource = new mlcontour.DemSource({
    url: DEM_URL,
    encoding: 'terrarium',
    maxzoom: 13,
    worker: true,
    cacheSize: 120,
    timeoutMs: 15000,
  });
  demSource.setupMaplibre(maplibregl);

  // Altitude sous le curseur, lue directement dans les tuiles du MNT
  const demTiles = new Map();
  async function altitudeAt(lng, lat) {
    const z = 13;
    const n = 2 ** z;
    const x = ((lng + 180) / 360) * n;
    const rad = (lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const key = `${tx}/${ty}`;
    if (!demTiles.has(key)) {
      if (demTiles.size > 64) demTiles.delete(demTiles.keys().next().value);
      demTiles.set(key, demSource.getDemTile(z, tx, ty));
    }
    const tile = await demTiles.get(key);
    const px = clamp(Math.floor((x - tx) * tile.width), 0, tile.width - 1);
    const py = clamp(Math.floor((y - ty) * tile.height), 0, tile.height - 1);
    return tile.data[py * tile.width + px];
  }

  // ------------------------------------------------------------------ Style
  const K = (kind) => ['==', ['get', 'kind'], kind];
  const diffColor = ['match', ['get', 'difficulty'],
    'novice', COLORS.novice, 'easy', COLORS.easy, 'intermediate', COLORS.intermediate,
    'advanced', COLORS.advanced, 'expert', COLORS.expert, 'freeride', COLORS.freeride, COLORS.unknown];
  const zoomWidth = (a, b) => ['interpolate', ['exponential', 1.5], ['zoom'], 12, a, 16.5, b];
  const NONE = ['==', ['get', 'gid'], '__none__'];
  // Les téléskis et tapis sont tracés plus fins que les télésièges
  const LIFT_WEIGHT = ['match', ['get', 'lift_type'], ['magic_carpet', 'rope_tow'], 0.6, ['drag_lift', 'platter', 't-bar', 'j-bar'], 0.8, 1];

  function vis(group) {
    if (group in state.toggles) return state.toggles[group] ? 'visible' : 'none';
    return group === state.basemap ? 'visible' : 'none';
  }
  function groupOf(id) {
    return Object.keys(LAYER_GROUPS).find((g) => LAYER_GROUPS[g].includes(id));
  }
  function withVisibility(layers) {
    for (const layer of layers) {
      const group = groupOf(layer.id);
      if (group) layer.layout = Object.assign({}, layer.layout, { visibility: vis(group) });
    }
    return layers;
  }

  function buildStyle() {
    const sources = {
      ofm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      'ign-ortho': { type: 'raster', tiles: [ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg')], tileSize: 256, maxzoom: 19, attribution: IGN_ATTRIB },
      'ign-plan': { type: 'raster', tiles: [ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png')], tileSize: 256, maxzoom: 18, attribution: IGN_ATTRIB },
      otm: {
        type: 'raster',
        tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
        tileSize: 256,
        maxzoom: 17,
        attribution: 'Carte <a href="https://opentopomap.org" target="_blank" rel="noopener">© OpenTopoMap</a> (CC-BY-SA)',
      },
      'terrain-dem': {
        type: 'raster-dem', encoding: 'terrarium', tiles: [demSource.sharedDemProtocolUrl], tileSize: 256, maxzoom: 13,
        attribution: 'Relief : <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Mapzen Terrarium</a>',
      },
      'hillshade-dem': { type: 'raster-dem', encoding: 'terrarium', tiles: [demSource.sharedDemProtocolUrl], tileSize: 256, maxzoom: 13 },
      contours: {
        type: 'vector',
        maxzoom: 15,
        tiles: [demSource.contourProtocolUrl({
          multiplier: 1,
          overzoom: 1,
          thresholds: { 11: [100, 500], 12: [50, 250], 13: [20, 100], 14: [10, 50] },
          elevationKey: 'ele',
          levelKey: 'level',
          contourLayer: 'contours',
        })],
      },
      resort: {
        type: 'geojson',
        data: DATA.geojson,
        attribution: 'Pistes <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© contributeurs OpenStreetMap</a>',
      },
    };

    const base = [
      { id: 'background', type: 'background', paint: { 'background-color': '#f6f8fa' } },
      // --- Plan des pistes (OpenFreeMap / OpenMapTiles), habillage hivernal
      {
        id: 'w-landuse', type: 'fill', source: 'ofm', 'source-layer': 'landuse',
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'neighbourhood', 'commercial', 'retail', 'industrial']]],
        paint: { 'fill-color': '#e9e6e1', 'fill-opacity': 0.9 },
      },
      {
        id: 'w-rock', type: 'fill', source: 'ofm', 'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['rock', 'sand']]],
        paint: { 'fill-color': '#e2e3e1', 'fill-opacity': 0.8 },
      },
      {
        id: 'w-wood', type: 'fill', source: 'ofm', 'source-layer': 'landcover',
        filter: ['==', ['get', 'class'], 'wood'],
        paint: { 'fill-color': '#cfe1ca', 'fill-opacity': 0.9 },
      },
      {
        id: 'w-wood-pattern', type: 'fill', source: 'ofm', 'source-layer': 'landcover', minzoom: 12,
        filter: ['==', ['get', 'class'], 'wood'],
        paint: { 'fill-pattern': 'forest', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 13, 0.85] },
      },
      { id: 'w-water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': '#a7c8e6' } },
      {
        id: 'w-waterway', type: 'line', source: 'ofm', 'source-layer': 'waterway',
        paint: { 'line-color': '#a7c8e6', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 16, 2] },
      },
      {
        id: 'w-track', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 13,
        filter: ['==', ['get', 'class'], 'track'],
        paint: { 'line-color': '#b9b2a6', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 16, 1.6], 'line-dasharray': [2, 2] },
      },
      {
        id: 'w-road-minor', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 12,
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'service']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#c3bdb3', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 16, 2.4] },
      },
      {
        id: 'w-road-major-casing', type: 'line', source: 'ofm', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#c2a77c', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 16, 8] },
      },
      {
        id: 'w-road-major', type: 'line', source: 'ofm', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 16, 5.6] },
      },
      {
        id: 'w-rail', type: 'line', source: 'ofm', 'source-layer': 'transportation',
        filter: ['==', ['get', 'class'], 'rail'],
        paint: { 'line-color': '#8f8a83', 'line-width': 1.4, 'line-dasharray': [3, 2] },
      },
      {
        id: 'w-building', type: 'fill', source: 'ofm', 'source-layer': 'building', minzoom: 14,
        paint: { 'fill-color': '#dcd5ca', 'fill-outline-color': '#c3b9ab' },
      },
      // --- Fonds raster
      { id: 'ign-ortho', type: 'raster', source: 'ign-ortho', paint: { 'raster-fade-duration': 150 } },
      { id: 'ign-plan', type: 'raster', source: 'ign-plan', paint: { 'raster-fade-duration': 150 } },
      { id: 'otm', type: 'raster', source: 'otm', paint: { 'raster-fade-duration': 150 } },
      // --- Relief
      {
        id: 'hillshade', type: 'hillshade', source: 'hillshade-dem',
        paint: hillshadePaint(state.basemap),
      },
      {
        id: 'contour-minor', type: 'line', source: 'contours', 'source-layer': 'contours',
        filter: ['==', ['get', 'level'], 0],
        paint: { 'line-color': '#6f86a3', 'line-opacity': 0.32, 'line-width': 0.6 },
      },
      {
        id: 'contour-major', type: 'line', source: 'contours', 'source-layer': 'contours',
        filter: ['>', ['get', 'level'], 0],
        paint: { 'line-color': '#5c7491', 'line-opacity': 0.55, 'line-width': 1.1 },
      },
      {
        id: 'contour-label', type: 'symbol', source: 'contours', 'source-layer': 'contours', minzoom: 13,
        filter: ['>', ['get', 'level'], 0],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' m'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
          'text-padding': 20,
        },
        paint: { 'text-color': '#4f6681', 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1.2 },
      },
      {
        id: 'w-road-label', type: 'symbol', source: 'ofm', 'source-layer': 'transportation_name', minzoom: 14,
        filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'tertiary']]],
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11 },
        paint: { 'text-color': '#6d6455', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
      },
    ];

    const overlay = [
      {
        id: 'boundary', type: 'line', source: 'resort', filter: K('boundary'),
        paint: { 'line-color': '#4d7bb3', 'line-width': 1.6, 'line-opacity': 0.55, 'line-dasharray': [4, 2] },
      },
      {
        id: 'piste-area', type: 'fill', source: 'resort',
        filter: ['all', K('piste-area'), ['==', ['get', 'piste_type'], 'downhill']],
        paint: { 'fill-color': diffColor, 'fill-opacity': 0.2 },
      },
      { id: 'snowpark-fill', type: 'fill', source: 'resort', filter: K('snowpark'), paint: { 'fill-color': '#f08a24', 'fill-opacity': 0.28 } },
      { id: 'snowpark-line', type: 'line', source: 'resort', filter: K('snowpark'), paint: { 'line-color': '#e07b00', 'line-width': 1.5 } },
      {
        id: 'hike-line', type: 'line', source: 'resort', filter: K('hike'),
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': HIKE_COLOR, 'line-width': zoomWidth(1, 3), 'line-dasharray': [0.6, 1.6], 'line-opacity': 0.9 },
      },
      {
        id: 'nordic-casing', type: 'line', source: 'resort', filter: K('nordic'),
        layout: { 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': zoomWidth(2.6, 7), 'line-opacity': 0.85 },
      },
      {
        id: 'nordic-line', type: 'line', source: 'resort', filter: K('nordic'),
        paint: { 'line-color': diffColor, 'line-width': zoomWidth(1.3, 3.6), 'line-dasharray': [2, 1.2] },
      },
      {
        id: 'piste-casing', type: 'line', source: 'resort', filter: K('piste'),
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': zoomWidth(3.4, 10), 'line-opacity': 0.92 },
      },
      {
        id: 'hover-glow', type: 'line', source: 'resort', filter: NONE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': SELECT_COLOR, 'line-width': zoomWidth(7, 18), 'line-opacity': 0.4, 'line-blur': 2 },
      },
      {
        id: 'select-glow', type: 'line', source: 'resort', filter: NONE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': SELECT_COLOR, 'line-width': zoomWidth(8, 20), 'line-opacity': 0.9, 'line-blur': 1.5 },
      },
      {
        id: 'piste-line', type: 'line', source: 'resort', filter: K('piste'),
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': diffColor, 'line-width': zoomWidth(1.8, 5.5) },
      },
      {
        id: 'lift-casing', type: 'line', source: 'resort', filter: K('lift'),
        paint: { 'line-color': '#ffffff', 'line-width': zoomWidth(3.2, 7), 'line-opacity': 0.9 },
      },
      {
        id: 'lift-line', type: 'line', source: 'resort', filter: K('lift'),
        paint: {
          'line-color': LIFT_COLOR,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, ['*', LIFT_WEIGHT, 1.5], 16.5, ['*', LIFT_WEIGHT, 3.4]],
        },
      },
      {
        id: 'pylon', type: 'circle', source: 'resort', filter: K('pylon'), minzoom: 14.5,
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14.5, 1.2, 17, 3], 'circle-color': LIFT_COLOR, 'circle-pitch-alignment': 'map' },
      },
      {
        id: 'station', type: 'circle', source: 'resort',
        filter: ['all', K('station'), ['!', ['in', ['get', 'lift_type'], ['literal', ['magic_carpet', 'rope_tow']]]]],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.4, 16, 6],
          'circle-color': '#ffffff',
          'circle-stroke-color': LIFT_COLOR,
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 1.4, 16, 2.6],
          'circle-pitch-alignment': 'map',
        },
      },
      // Couches invisibles, plus larges, pour viser facilement au doigt
      hitLayer('hike-hit', K('hike')),
      hitLayer('nordic-hit', K('nordic')),
      hitLayer('piste-hit', K('piste')),
      hitLayer('lift-hit', K('lift')),
      // --- Étiquettes
      {
        id: 'snowpark-label', type: 'symbol', source: 'resort', filter: K('snowpark'), minzoom: 14,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 12 },
        paint: { 'text-color': '#b35900', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
      },
      {
        id: 'hike-label', type: 'symbol', source: 'resort', filter: ['all', K('hike'), ['has', 'name']], minzoom: 14.5,
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': 11 },
        paint: { 'text-color': HIKE_COLOR, 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      },
      {
        id: 'nordic-label', type: 'symbol', source: 'resort', filter: ['all', K('nordic'), ['has', 'name']], minzoom: 14,
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': 400,
          'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': 11.5,
        },
        paint: { 'text-color': NORDIC_COLOR, 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
      },
      {
        id: 'piste-label', type: 'symbol', source: 'resort', filter: ['all', K('piste'), ['has', 'name']], minzoom: 13.2,
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 320,
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 12, 16, 16],
          'text-max-angle': 35,
          'text-letter-spacing': 0.03,
        },
        paint: { 'text-color': diffColor, 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
      },
      {
        id: 'lift-label', type: 'symbol', source: 'resort',
        filter: ['all', K('lift'), ['!', ['in', ['get', 'lift_type'], ['literal', ['magic_carpet', 'rope_tow']]]]],
        minzoom: 13.4,
        layout: {
          'symbol-placement': 'line-center',
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 11.5, 16, 14],
          'text-offset': [0, -0.9],
          'text-max-angle': 50,
        },
        paint: { 'text-color': LIFT_COLOR, 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
      },
      {
        id: 'poi-icons', type: 'symbol', source: 'resort', minzoom: 13,
        filter: ['in', ['get', 'kind'], ['literal', ['restaurant', 'parking', 'viewpoint', 'info', 'first_aid']]],
        layout: {
          'icon-image': ['concat', 'icon-', ['get', 'kind']],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.75, 16, 1],
          'icon-allow-overlap': false,
          'text-field': ['step', ['zoom'], '', 15.2, ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-anchor': 'top',
          'text-offset': [0, 1.2],
          'text-optional': true,
        },
        paint: { 'text-color': '#3a3530', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      },
      {
        id: 'pass-label', type: 'symbol', source: 'resort', filter: K('pass'), minzoom: 13,
        layout: {
          'icon-image': 'icon-pass',
          'text-field': ['format', ['get', 'name'], {}, '\n', {}, ['concat', ['to-string', ['get', 'ele']], ' m'], { 'font-scale': 0.85 }],
          'text-font': ['Noto Sans Italic'],
          'text-size': 11,
          'text-anchor': 'top',
          'text-offset': [0, 0.7],
          'text-optional': true,
        },
        paint: { 'text-color': '#4b4038', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
      },
      {
        id: 'peak-label', type: 'symbol', source: 'resort', filter: K('peak'), minzoom: 10,
        layout: {
          'icon-image': 'icon-peak',
          'text-field': ['format', ['get', 'name'], {}, '\n', {}, ['concat', ['to-string', ['get', 'ele']], ' m'], { 'font-scale': 0.85 }],
          'text-font': ['Noto Sans Bold'],
          'text-size': 12,
          'text-anchor': 'top',
          'text-offset': [0, 0.6],
          'text-optional': true,
          'symbol-sort-key': ['-', 0, ['get', 'ele']],
        },
        paint: { 'text-color': '#3d3027', 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
      },
      {
        id: 'place-minor', type: 'symbol', source: 'resort', filter: ['all', K('place'), ['==', ['get', 'rank'], 2]], minzoom: 12.5,
        layout: {
          'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 11.5,
          'text-transform': 'uppercase', 'text-letter-spacing': 0.1,
        },
        paint: { 'text-color': '#40506a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
      },
      {
        id: 'place-major', type: 'symbol', source: 'resort', filter: ['all', K('place'), ['==', ['get', 'rank'], 1]],
        layout: {
          'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 13, 15, 17],
          'text-transform': 'uppercase', 'text-letter-spacing': 0.12,
        },
        paint: { 'text-color': '#14273d', 'text-halo-color': '#ffffff', 'text-halo-width': 2.2 },
      },
    ];

    const style = {
      version: 8,
      glyphs: GLYPHS,
      sources,
      layers: withVisibility([...base, ...overlay]),
      sky: {
        'sky-color': '#79aee3',
        'sky-horizon-blend': 0.55,
        'horizon-color': '#dde9f5',
        'horizon-fog-blend': 0.6,
        'fog-color': '#edf2f7',
        'fog-ground-blend': 0.8,
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 0],
      },
    };
    if (state.toggles.terrain) style.terrain = { source: 'terrain-dem', exaggeration: state.exaggeration };
    return style;
  }

  function hitLayer(id, filter) {
    return {
      id, type: 'line', source: 'resort', filter,
      paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 16 },
    };
  }

  function hillshadePaint(basemap) {
    const onPhoto = basemap === 'ortho';
    return {
      'hillshade-exaggeration': onPhoto ? 0.25 : basemap === 'hiver' ? 0.55 : 0.35,
      'hillshade-shadow-color': '#3f5574',
      'hillshade-highlight-color': '#ffffff',
      'hillshade-accent-color': '#5d7392',
      'hillshade-illumination-direction': 315,
    };
  }

  // ------------------------------------------------------------------ Icônes
  // Pictogrammes dessinés à la volée (Path2D) : aucun fichier image à héberger.
  const MATERIAL = { // tracés Material Icons (Apache 2.0)
    restaurant: 'M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z',
    viewpoint: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
  };
  const PR = 2; // densité de pixels des icônes

  function canvas(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size * PR;
    const g = c.getContext('2d');
    g.scale(PR, PR);
    return [c, g];
  }
  function badge(bg, draw, shape = 'circle') {
    const size = 26;
    const [c, g] = canvas(size);
    g.fillStyle = bg;
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2;
    g.beginPath();
    if (shape === 'circle') g.arc(13, 13, 11, 0, Math.PI * 2);
    else g.roundRect(2, 2, 22, 22, 5);
    g.fill();
    g.stroke();
    g.fillStyle = '#ffffff';
    draw(g);
    return g.getImageData(0, 0, c.width, c.height);
  }
  const glyph = (text, size) => (g) => {
    g.font = `700 ${size}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 13, 14);
  };
  const material = (name) => (g) => {
    g.translate(6, 6);
    g.scale(14 / 24, 14 / 24);
    g.fill(new Path2D(MATERIAL[name]));
  };
  const ICONS = {
    'icon-restaurant': () => badge('#b6501c', material('restaurant')),
    'icon-viewpoint': () => badge('#14273d', material('viewpoint')),
    'icon-parking': () => badge('#2459b3', glyph('P', 17), 'square'),
    'icon-info': () => badge('#2f7f7a', glyph('i', 17)),
    'icon-first_aid': () => badge('#c8202a', (g) => { g.fillRect(11, 6.5, 4, 13); g.fillRect(6.5, 11, 13, 4); }, 'square'),
    'icon-peak': () => {
      const [c, g] = canvas(16);
      g.beginPath();
      g.moveTo(8, 2); g.lineTo(14.5, 13.5); g.lineTo(1.5, 13.5); g.closePath();
      g.fillStyle = '#5b4a3e'; g.strokeStyle = '#ffffff'; g.lineWidth = 1.6;
      g.fill(); g.stroke();
      return g.getImageData(0, 0, c.width, c.height);
    },
    'icon-pass': () => {
      const [c, g] = canvas(16);
      g.beginPath();
      g.moveTo(1.5, 5); g.quadraticCurveTo(8, 13, 14.5, 5);
      g.strokeStyle = '#ffffff'; g.lineWidth = 4.5; g.stroke();
      g.strokeStyle = '#5b4a3e'; g.lineWidth = 2; g.stroke();
      return g.getImageData(0, 0, c.width, c.height);
    },
    forest: () => {
      // Motif de sapins, comme sur les plans des pistes peints à la main
      const [c, g] = canvas(36);
      const fir = (x, y, s) => {
        g.fillStyle = '#6c5440';
        g.fillRect(x - 0.6 * s, y + 3.2 * s, 1.2 * s, 1.6 * s);
        g.fillStyle = '#4f8250';
        g.beginPath();
        g.moveTo(x, y - 4 * s); g.lineTo(x + 3 * s, y + 3.4 * s); g.lineTo(x - 3 * s, y + 3.4 * s); g.closePath();
        g.fill();
        g.fillStyle = '#679a63';
        g.beginPath();
        g.moveTo(x, y - 4 * s); g.lineTo(x + 1.2 * s, y - 0.6 * s); g.lineTo(x - 1.6 * s, y + 2 * s); g.closePath();
        g.fill();
      };
      fir(7, 8, 1);
      fir(25, 5, 0.85);
      fir(17, 20, 1.1);
      fir(31, 26, 0.9);
      fir(6, 29, 0.8);
      return g.getImageData(0, 0, c.width, c.height);
    },
  };

  // ------------------------------------------------------------------ Carte
  const sharedView = window.location.hash.length > 1; // position partagée via l'URL (#zoom/lat/lng/…)
  const map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(),
    center: HOME.center,
    zoom: isMobile() ? HOME_MOBILE.zoom : HOME.zoom,
    pitch: HOME.pitch,
    bearing: HOME.bearing,
    maxPitch: 80,
    minZoom: 10,
    maxBounds: [[1.75, 42.38], [2.32, 42.68]],
    hash: true,
    attributionControl: { compact: true },
    locale: {
      'NavigationControl.ZoomIn': 'Zoom avant',
      'NavigationControl.ZoomOut': 'Zoom arrière',
      'NavigationControl.ResetBearing': 'Réorienter vers le nord',
      'GeolocateControl.FindMyLocation': 'Me localiser',
      'GeolocateControl.LocationNotAvailable': 'Position indisponible',
      'FullscreenControl.Enter': 'Plein écran',
      'FullscreenControl.Exit': 'Quitter le plein écran',
      'ScaleControl.Meters': 'm',
      'ScaleControl.Kilometers': 'km',
      'AttributionControl.ToggleAttribution': 'Sources',
    },
  });
  window.fontRomeuMap = map; // pratique pour déboguer depuis la console

  map.on('styleimagemissing', (e) => {
    const make = ICONS[e.id];
    if (make && !map.hasImage(e.id)) map.addImage(e.id, make(), { pixelRatio: PR });
  });

  // Barre d'outils maison intégrée à la pile de contrôles MapLibre
  const toolbar = document.querySelector('.toolbar');
  map.addControl({
    onAdd() { toolbar.classList.add('maplibregl-ctrl'); return toolbar; },
    onRemove() { toolbar.remove(); },
  }, 'top-right');
  // Sur téléphone, le zoom se fait au pincement : on allège la pile de boutons
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showZoom: !isMobile() }), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
  if (!isMobile()) map.addControl(new maplibregl.FullscreenControl(), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 110 }), 'bottom-left');

  map.once('idle', () => loading.classList.add('done'));
  setTimeout(() => loading.classList.add('done'), 12000);

  // ------------------------------------------------------------------ Calques
  function setGroupVisibility(group, visible) {
    for (const id of LAYER_GROUPS[group]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  function setBasemap(id) {
    state.basemap = id;
    for (const b of BASEMAPS) setGroupVisibility(b.id, b.id === id);
    const paint = hillshadePaint(id);
    for (const [k, v] of Object.entries(paint)) map.setPaintProperty('hillshade', k, v);
    // Les courbes restent lisibles sur la photo aérienne en blanc
    map.setPaintProperty('contour-minor', 'line-color', id === 'ortho' ? '#ffffff' : '#6f86a3');
    map.setPaintProperty('contour-major', 'line-color', id === 'ortho' ? '#ffffff' : '#5c7491');
    document.querySelectorAll('.basemap').forEach((el) => el.setAttribute('aria-checked', String(el.dataset.id === id)));
    savePrefs();
  }

  function setTerrain(on) {
    state.toggles.terrain = on;
    map.setTerrain(on ? { source: 'terrain-dem', exaggeration: state.exaggeration } : null);
    document.getElementById('opt-exaggeration').disabled = !on;
    savePrefs();
  }

  function applyDifficultyFilter() {
    const allowed = ['in', ['get', 'difficulty'], ['literal', [...state.difficulties, 'unknown']]];
    map.setFilter('piste-line', ['all', K('piste'), allowed]);
    map.setFilter('piste-casing', ['all', K('piste'), allowed]);
    map.setFilter('piste-hit', ['all', K('piste'), allowed]);
    map.setFilter('piste-label', ['all', K('piste'), ['has', 'name'], allowed]);
    map.setFilter('piste-area', ['all', K('piste-area'), ['==', ['get', 'piste_type'], 'downhill'], allowed]);
  }

  // ------------------------------------------------------------------ Interface : panneau
  const $ = (id) => document.getElementById(id);
  const panel = $('panel');
  const list = $('list');

  function renderFacts() {
    $('facts').innerHTML = [
      ['Pistes', `${summary.pistes}`],
      ['Remontées', `${summary.lifts}`],
      ['Alpin', `${nf.format(Math.round(summary.downhill_km))}<small> km</small>`],
      ['Altitude', `${summary.alt_min}<small>–</small>${summary.alt_max}<small> m</small>`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    const date = DATA.meta.osm_timestamp ? new Date(DATA.meta.osm_timestamp) : null;
    $('data-note').innerHTML =
      `Tracés <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>` +
      (date ? ` (état au ${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })})` : '') +
      ', altitudes calculées sur le modèle de terrain. Indicatif : consultez l’ouverture des pistes sur place.';
  }

  function renderDifficultyChips() {
    const counts = summary.by_difficulty;
    $('difficulty-filter').innerHTML = DIFFICULTIES.filter((d) => counts[d] > 0).map((d) => `
      <button type="button" class="chip" data-d="${d}" aria-pressed="${state.difficulties.has(d)}">
        <span class="dot" data-d="${d}"></span>${DIFF_LABEL[d]}<span class="count">${counts[d]}</span>
      </button>`).join('');
  }

  function itemsForTab() {
    const q = normalize(state.query).trim();
    let items;
    if (state.tab === 'lifts') {
      items = DATA.lifts.slice();
    } else if (state.tab === 'nordic') {
      items = DATA.pistes.filter((p) => (p.kind === 'nordic' || p.kind === 'hike') && p.name && p.length >= 300);
    } else {
      items = DATA.pistes.filter((p) => p.kind === 'piste' && p.name && state.difficulties.has(p.difficulty));
    }
    if (q) items = items.filter((it) => normalize(`${it.name} ${it.name_ca || ''} ${it.abbr || ''}`).includes(q));
    const by = {
      length: (a, b) => b.length - a.length,
      drop: (a, b) => (b.drop ?? b.rise) - (a.drop ?? a.rise),
      top: (a, b) => b.top - a.top,
      name: (a, b) => a.name.localeCompare(b.name, 'fr'),
    }[state.sort];
    if (by) items.sort(by);
    return items;
  }

  function renderList() {
    const items = itemsForTab();
    const selectedId = state.selected && (state.selected.gid || state.selected.id);
    if (!items.length) {
      list.innerHTML = `<li class="empty">Aucun résultat${state.query ? ` pour « ${esc(state.query)} »` : ''}.</li>`;
      return;
    }
    list.innerHTML = items.map((it) => {
      const id = it.gid || it.id;
      let marker;
      let sub;
      let stats;
      if (it.lift_type) {
        marker = `<span class="badge">${it.abbr}</span>`;
        sub = liftKind(it);
        stats = `<strong>${fmtLen(it.length)}</strong>+${nf.format(it.rise)} m`;
      } else if (it.kind === 'piste') {
        marker = `<span class="dot" data-d="${it.difficulty}"></span>`;
        sub = it.name_ca && it.name_ca !== it.name ? `${it.name_ca} (cat.)` : `${nf.format(it.top)} → ${nf.format(it.bottom)} m`;
        stats = `<strong>${fmtLen(it.length)}</strong>−${nf.format(it.drop)} m`;
      } else {
        const c = it.kind === 'hike' ? HIKE_COLOR : COLORS[it.difficulty] || NORDIC_COLOR;
        marker = `<span class="line-swatch" style="--c:${c}"></span>`;
        sub = pisteKind(it);
        stats = `<strong>${fmtLen(it.length)}</strong>${nf.format(it.bottom)}–${nf.format(it.top)} m`;
      }
      return `<li><button type="button" class="item" data-id="${esc(id)}" aria-current="${id === selectedId}">
        ${marker}
        <span><span class="item-name">${esc(it.name)}</span><span class="item-sub">${esc(sub)}</span></span>
        <span class="item-stats">${stats}</span>
      </button></li>`;
    }).join('');
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tabs [role="tab"]').forEach((t) => {
      const on = t.dataset.tab === tab;
      t.setAttribute('aria-selected', String(on));
      if (on) list.setAttribute('aria-labelledby', t.id);
    });
    $('difficulty-filter').hidden = tab !== 'pistes';
    renderList();
  }

  // ------------------------------------------------------------------ Sélection et fiche
  const details = $('details');
  const marker = (() => {
    const el = document.createElement('div');
    el.className = 'profile-marker';
    return new maplibregl.Marker({ element: el });
  })();

  function entryFromFeature(f) {
    const p = f.properties;
    if (p.kind === 'lift') return liftById.get(p.id);
    if (p.kind === 'station') return liftById.get(p.lift);
    if (p.gid) return pisteById.get(p.gid);
    return null;
  }

  function highlight(layer, entry) {
    if (!entry) return map.setFilter(layer, NONE);
    if (entry.lift_type) return map.setFilter(layer, ['all', K('lift'), ['==', ['get', 'id'], entry.id]]);
    return map.setFilter(layer, ['==', ['get', 'gid'], entry.gid]);
  }

  function select(entry, { fly = true } = {}) {
    stopAnimations();
    state.selected = entry;
    highlight('select-glow', entry);
    marker.remove();
    if (!entry) {
      details.hidden = true;
      renderList();
      return;
    }
    renderDetails(entry);
    renderList();
    if (isMobile()) panel.dataset.state = 'peek';
    if (fly) flyToEntry(entry);
  }

  function homeView() {
    return isMobile()
      ? { ...HOME_MOBILE, padding: { top: 0, left: 0, right: 0, bottom: panel.offsetHeight } }
      : { ...HOME, padding: { top: 0, bottom: 0, right: 0, left: panel.offsetWidth } };
  }

  function cameraPadding() {
    if (isMobile()) {
      return { top: 70, left: 30, right: 60, bottom: Math.round(window.innerHeight * 0.55) };
    }
    return { top: 60, bottom: 60, left: panel.offsetWidth + 40, right: details.hidden ? 90 : details.offsetWidth + 50 };
  }

  // Cadre l'élément vu de l'aval, face à la pente, comme sur un plan des pistes
  function flyToEntry(entry) {
    const [w, s, e, n] = entry.bbox;
    const profile = entry.profile;
    let low = profile[0];
    let high = profile[0];
    for (const p of profile) {
      if (p[1] < low[1]) low = p;
      if (p[1] > high[1]) high = p;
    }
    const dx = (high[2] - low[2]) * Math.cos((high[3] * Math.PI) / 180);
    const dy = high[3] - low[3];
    const bearing = high[1] - low[1] > 25 && Math.hypot(dx, dy) > 0.0015
      ? bearingBetween({ lng: low[2], lat: low[3] }, { lng: high[2], lat: high[3] })
      : map.getBearing();
    const padding = cameraPadding();
    const cam = map.cameraForBounds([[w, s], [e, n]], { padding, bearing });
    if (!cam) return;
    const pitched = map.getPitch() > 20;
    map.flyTo({
      center: [(w + e) / 2, (s + n) / 2],
      zoom: clamp(cam.zoom - (pitched ? 0.35 : 0), 12, 16.4),
      bearing: pitched ? bearing : map.getBearing(),
      pitch: map.getPitch(),
      padding,
      duration: 1600,
    });
  }

  function statCell(label, value) {
    return `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  }

  function renderDetails(entry) {
    const isLift = Boolean(entry.lift_type);
    let sign;
    let kicker;
    let color;
    let stats;
    let action;
    if (isLift) {
      color = LIFT_COLOR;
      sign = `<div class="details-sign square" style="--c:${color}">${entry.abbr}</div>`;
      kicker = liftKind(entry);
      stats = [
        statCell('Longueur', fmtLen(entry.length_slope || entry.length)),
        statCell('Dénivelé', `+${nf.format(entry.rise)}<small> m</small>`),
        statCell('Pente moy.', `${entry.avg_slope}<small> %</small>`),
        statCell('Départ', `${nf.format(entry.bottom)}<small> m</small>`),
        statCell('Arrivée', `${nf.format(entry.top)}<small> m</small>`),
        entry.capacity
          ? statCell('Débit', `${nf.format(entry.capacity)}<small> pers/h</small>`)
          : entry.duration
            ? statCell('Trajet', `${entry.duration}<small> min</small>`)
            : statCell('Places', entry.occupancy ? `${entry.occupancy}` : '—'),
      ].join('');
      action = 'Monter en 3D';
    } else {
      color = entry.kind === 'hike' ? HIKE_COLOR : COLORS[entry.difficulty] || COLORS.unknown;
      const dashed = entry.kind !== 'piste';
      sign = `<div class="details-sign${dashed ? ' dashed' : ''}" style="--c:${color}" aria-hidden="true"></div>`;
      kicker = pisteKind(entry);
      stats = [
        statCell('Longueur', fmtLen(entry.length)),
        statCell('Dénivelé', `${entry.kind === 'piste' ? '−' : ''}${nf.format(entry.drop)}<small> m</small>`),
        statCell('Pente moy.', `${entry.avg_slope}<small> %</small>`),
        statCell('Haut', `${nf.format(entry.top)}<small> m</small>`),
        statCell('Bas', `${nf.format(entry.bottom)}<small> m</small>`),
        statCell('Pente max.', `${entry.max_slope}<small> %</small>`),
      ].join('');
      action = entry.kind === 'piste' ? 'Descente en 3D' : 'Parcourir en 3D';
    }
    const name = entry.name || (isLift ? 'Remontée' : `${kicker} sans nom`);
    const altName = entry.name_ca && entry.name_ca !== entry.name ? `<p class="alt-name">En catalan : ${esc(entry.name_ca)}</p>` : '';
    const notes = [];
    if (entry.lit) notes.push('Piste éclairée pour le ski de nuit.');
    if (isLift && entry.summer) notes.push('Également ouvert l’été (piétons, VTT).');
    if (isLift && entry.bubble === 'yes') notes.push('Avec bulle de protection.');
    if (!isLift && entry.segments > 1) notes.push(`Piste composée de ${entry.segments} tronçons ; le profil suit le tracé principal.`);

    details.innerHTML = `
      <div class="details-head">
        ${sign}
        <div>
          <p class="details-kicker">${esc(kicker)}</p>
          <h2>${esc(name)}</h2>
          ${altName}
        </div>
        <button type="button" class="close" id="details-close" aria-label="Fermer la fiche">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3 1.4 1.4Z" transform="translate(1.5 0)"/></svg>
        </button>
      </div>
      <dl class="stats">${stats}</dl>
      <div class="profile">
        <div class="profile-title"><span>Profil altimétrique</span><output id="profile-readout"></output></div>
        <div id="profile-chart"></div>
      </div>
      <div class="details-actions">
        <button type="button" class="btn primary" id="btn-fly">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>${action}
        </button>
        <button type="button" class="btn" id="btn-zoom">Centrer</button>
      </div>
      ${notes.length ? `<p class="note">${notes.map(esc).join(' ')}</p>` : ''}`;
    details.hidden = false;
    details.style.setProperty('--c', color);
    renderProfile($('profile-chart'), entry, color);
    $('details-close').addEventListener('click', () => select(null));
    $('btn-zoom').addEventListener('click', () => flyToEntry(entry));
    $('btn-fly').addEventListener('click', () => flyAlong(entry));
  }

  // ------------------------------------------------------------------ Profil altimétrique
  function niceStep(raw) {
    const pow = 10 ** Math.floor(Math.log10(raw));
    const n = raw / pow;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
  }

  function pointAlong(profile, d) {
    if (d <= 0) return { lng: profile[0][2], lat: profile[0][3], z: profile[0][1], d: 0 };
    for (let i = 1; i < profile.length; i++) {
      const a = profile[i - 1];
      const b = profile[i];
      if (d <= b[0]) {
        const t = b[0] === a[0] ? 0 : (d - a[0]) / (b[0] - a[0]);
        return { lng: a[2] + (b[2] - a[2]) * t, lat: a[3] + (b[3] - a[3]) * t, z: a[1] + (b[1] - a[1]) * t, d };
      }
    }
    const last = profile[profile.length - 1];
    return { lng: last[2], lat: last[3], z: last[1], d: last[0] };
  }

  let profileCursor = null; // (distance) => void, mis à jour par renderProfile

  function renderProfile(container, entry, color) {
    const profile = entry.profile;
    const W = 340;
    const H = 132;
    const m = { l: 40, r: 10, t: 10, b: 22 };
    const L = profile[profile.length - 1][0] || 1;
    const zs = profile.map((p) => p[1]);
    const zmin = Math.min(...zs);
    const zmax = Math.max(...zs);
    const span = Math.max(zmax - zmin, 30);
    const step = niceStep(span / 3);
    const lo = Math.floor((zmin - span * 0.05) / step) * step;
    const hi = Math.ceil((zmax + span * 0.05) / step) * step;
    const x = (d) => m.l + (d / L) * (W - m.l - m.r);
    const y = (z) => m.t + ((hi - z) / (hi - lo)) * (H - m.t - m.b);

    let grid = '';
    for (let z = lo; z <= hi + 0.1; z += step) {
      grid += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(z)}" y2="${y(z)}"/>`;
      grid += `<text class="axis" x="${m.l - 5}" y="${y(z) + 3.5}" text-anchor="end">${nf.format(z)}</text>`;
    }
    const xstep = niceStep(L / 4);
    for (let d = 0; d <= L + 0.1; d += xstep) {
      const label = d === 0 ? '0' : d >= 1000 ? `${nf1.format(d / 1000).replace(',0', '')} km` : `${nf.format(d)} m`;
      const anchor = x(d) > W - m.r - 18 ? 'end' : 'middle';
      grid += `<text class="axis" x="${x(d)}" y="${H - 6}" text-anchor="${anchor}">${label}</text>`;
    }
    const line = profile.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    const area = `${line}L${x(L).toFixed(1)},${H - m.b}L${m.l},${H - m.b}Z`;

    container.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Profil : de ${nf.format(Math.round(profile[0][1]))} m à ${nf.format(Math.round(profile[profile.length - 1][1]))} m sur ${fmtLen(L)}">
        ${grid}
        <path class="area" d="${area}" style="--c:${color}"/>
        <path class="curve" d="${line}" style="--c:${color}"/>
        <line class="cursor" id="pc-line" y1="${m.t}" y2="${H - m.b}" x1="-10" x2="-10"/>
        <circle class="cursor-dot" id="pc-dot" r="4.5" cx="-10" cy="-10"/>
        <rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" id="pc-hit"/>
      </svg>`;
    const svg = container.querySelector('svg');
    const readout = $('profile-readout');
    const lineEl = svg.querySelector('#pc-line');
    const dot = svg.querySelector('#pc-dot');

    profileCursor = (d) => {
      if (d === null) {
        lineEl.setAttribute('x1', -10); lineEl.setAttribute('x2', -10);
        dot.setAttribute('cx', -10);
        readout.textContent = '';
        marker.remove();
        return;
      }
      const pt = pointAlong(profile, d);
      lineEl.setAttribute('x1', x(pt.d)); lineEl.setAttribute('x2', x(pt.d));
      dot.setAttribute('cx', x(pt.d)); dot.setAttribute('cy', y(pt.z));
      readout.textContent = `${fmtLen(pt.d)} · ${fmtM(pt.z)}`;
      marker.setLngLat([pt.lng, pt.lat]).addTo(map);
    };
    const fromEvent = (ev) => {
      const r = svg.getBoundingClientRect();
      const sx = ((ev.clientX - r.left) / r.width) * W;
      return clamp(((sx - m.l) / (W - m.l - m.r)) * L, 0, L);
    };
    svg.addEventListener('pointermove', (ev) => { if (!flight) profileCursor(fromEvent(ev)); });
    svg.addEventListener('pointerdown', (ev) => { if (!flight) profileCursor(fromEvent(ev)); });
    svg.addEventListener('pointerleave', () => { if (!flight) profileCursor(null); });
  }

  // ------------------------------------------------------------------ Animations de caméra
  let flight = null;
  let tour = null;

  function stopAnimations() {
    if (flight) { cancelAnimationFrame(flight.raf); flight = null; }
    if (tour) { cancelAnimationFrame(tour.raf); tour = null; $('btn-tour').setAttribute('aria-pressed', 'false'); }
  }

  function bearingBetween(a, b) {
    const toRad = Math.PI / 180;
    const y = Math.sin((b.lng - a.lng) * toRad) * Math.cos(b.lat * toRad);
    const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
      Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lng - a.lng) * toRad);
    return (Math.atan2(y, x) / toRad + 360) % 360;
  }
  function lerpAngle(a, b, t) {
    const diff = ((b - a + 540) % 360) - 180;
    return a + diff * t;
  }

  // Survol du tracé : la caméra suit la piste (ou la remontée) de bout en bout
  function flyAlong(entry) {
    stopAnimations();
    const profile = entry.profile;
    const L = profile[profile.length - 1][0];
    const speed = entry.lift_type ? 30 : 45; // m/s simulés
    const duration = clamp((L / speed) * 1000, 7000, 40000);
    const start = pointAlong(profile, 0);
    const look = pointAlong(profile, Math.min(L, 150));
    let bearing = bearingBetween(start, look);
    flight = { raf: 0 };
    map.once('moveend', () => {
      if (!flight) return;
      let t0 = null;
      const frame = (ts) => {
        if (!flight) return;
        if (t0 === null) t0 = ts;
        const t = Math.min(1, (ts - t0) / duration);
        const eased = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
        const d = eased * L;
        const pt = pointAlong(profile, d);
        const ahead = pointAlong(profile, Math.min(L, d + 160));
        if (ahead.d - pt.d > 20) bearing = lerpAngle(bearing, bearingBetween(pt, ahead), 0.04);
        map.jumpTo({ center: [pt.lng, pt.lat], bearing, pitch: FLIGHT.pitch, zoom: FLIGHT.zoom });
        if (profileCursor) profileCursor(d);
        if (t < 1) flight.raf = requestAnimationFrame(frame);
        else flight = null;
      };
      flight.raf = requestAnimationFrame(frame);
    });
    map.flyTo({ center: [start.lng, start.lat], zoom: FLIGHT.zoom, pitch: FLIGHT.pitch, bearing, duration: 1800 });
  }

  // Tour panoramique : rotation lente autour du domaine
  function toggleTour() {
    if (tour) { stopAnimations(); return; }
    stopAnimations();
    $('btn-tour').setAttribute('aria-pressed', 'true');
    tour = { raf: 0 };
    const zoom = isMobile() ? 13 : 13.5;
    map.once('moveend', () => {
      if (!tour) return;
      let last = null;
      const frame = (ts) => {
        if (!tour) return;
        if (last !== null) map.setBearing(map.getBearing() + (ts - last) * 0.006);
        last = ts;
        tour.raf = requestAnimationFrame(frame);
      };
      tour.raf = requestAnimationFrame(frame);
    });
    map.easeTo({ center: HOME.center, zoom, pitch: 68, duration: 1500 });
  }

  // Toute interaction manuelle reprend la main sur la caméra
  ['mousedown', 'touchstart', 'wheel'].forEach((type) => {
    map.getCanvasContainer().addEventListener(type, () => {
      if (flight || tour) {
        stopAnimations();
        if (profileCursor) profileCursor(null);
      }
    }, { passive: true });
  });

  // ------------------------------------------------------------------ Survol et clic
  const status = $('cursor-alt');
  let hovered = null;
  let altRequest = 0;
  let pendingMove = null;

  function hitLayers() {
    return HIT_LAYERS.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
  }

  function describeFeature(f) {
    const p = f.properties;
    const entry = entryFromFeature(f);
    if (entry?.lift_type) return `${entry.abbr} ${entry.name}`;
    if (entry) return entry.name ? `${entry.name} · ${pisteKind(entry).toLowerCase()}` : pisteKind(entry);
    return p.name || '';
  }

  function onMove(e) {
    const features = map.queryRenderedFeatures(e.point, { layers: hitLayers() });
    const f = features[0];
    const entry = f ? entryFromFeature(f) : null;
    map.getCanvas().style.cursor = f ? 'pointer' : '';
    if (entry !== hovered) {
      hovered = entry;
      highlight('hover-glow', entry);
    }
    const label = f ? describeFeature(f) : '';
    const { lng, lat } = e.lngLat;
    const req = ++altRequest;
    altitudeAt(lng, lat).then((z) => {
      if (req !== altRequest) return;
      status.innerHTML = `${label ? `<strong>${esc(label)}</strong> · ` : ''}Altitude <strong>${fmtM(z)}</strong> · ${coord.format(lat)}° N, ${coord.format(lng)}° E`;
    }).catch(() => {});
  }

  map.on('mousemove', (e) => {
    if (pendingMove) { pendingMove = e; return; }
    pendingMove = e;
    requestAnimationFrame(() => { const ev = pendingMove; pendingMove = null; onMove(ev); });
  });
  map.on('mouseout', () => {
    hovered = null;
    highlight('hover-glow', null);
  });

  const popup = new maplibregl.Popup({ closeButton: false, offset: 14, maxWidth: '240px' });
  const POI_LABEL = {
    restaurant: 'Restaurant', parking: 'Parking', viewpoint: 'Point de vue', info: 'Information',
    first_aid: 'Poste de secours', peak: 'Sommet', pass: 'Col',
  };

  map.on('click', (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: hitLayers() });
    const f = features[0];
    popup.remove();
    if (!f) {
      if (!details.hidden && isMobile()) select(null);
      return;
    }
    const entry = entryFromFeature(f);
    if (entry) { select(entry, { fly: false }); return; }
    const p = f.properties;
    const extra = [];
    if (p.ele) extra.push(fmtM(p.ele));
    if (p.capacity) extra.push(`${nf.format(p.capacity)} places`);
    if (p.fee === 'no') extra.push('gratuit');
    popup.setLngLat(f.geometry.coordinates)
      .setHTML(`<strong>${esc(p.name)}</strong>${esc(POI_LABEL[p.kind] || '')}${extra.length ? ` · ${esc(extra.join(' · '))}` : ''}`)
      .addTo(map);
  });

  // ------------------------------------------------------------------ Panneau des calques
  function renderLayersPanel() {
    $('basemaps').innerHTML = BASEMAPS.map((b) => `
      <button type="button" class="basemap" role="radio" data-id="${b.id}" aria-checked="${b.id === state.basemap}">
        <span class="thumb" style="--thumb:${b.thumb}"></span>${b.label}
      </button>`).join('');
    const legend = [
      [`<span class="sample" style="--c:${COLORS.novice}"></span>`, 'Piste verte'],
      [`<span class="sample" style="--c:${COLORS.easy}"></span>`, 'Piste bleue'],
      [`<span class="sample" style="--c:${COLORS.intermediate}"></span>`, 'Piste rouge'],
      [`<span class="sample" style="--c:${COLORS.advanced}"></span>`, 'Piste noire'],
      ['<span class="sample lift"></span>', 'Remontée mécanique et gare'],
      [`<span class="sample dashed" style="--c:${COLORS.easy}"></span>`, 'Ski de fond (couleur = difficulté)'],
      [`<span class="sample dashed" style="--c:${HIKE_COLOR}"></span>`, 'Raquettes / piétons'],
      ['<span class="sample" style="--c:#f08a24"></span>', 'Snowpark'],
    ];
    $('legend').innerHTML = legend.map(([s, l]) => `<li>${s}${l}</li>`).join('');

    for (const key of ['terrain', 'hillshade', 'contours', 'pistes', 'lifts', 'nordic', 'hike', 'pois']) {
      $(`opt-${key}`).checked = state.toggles[key];
    }
    $('opt-exaggeration').value = state.exaggeration;
    $('opt-exaggeration').disabled = !state.toggles.terrain;
    $('exaggeration-value').textContent = `×${nf1.format(state.exaggeration)}`;
  }

  // ------------------------------------------------------------------ Événements de l'interface
  $('difficulty-filter').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const d = chip.dataset.d;
    if (state.difficulties.has(d)) state.difficulties.delete(d);
    else state.difficulties.add(d);
    if (d === 'advanced') { // « expert » suit « noire »
      if (state.difficulties.has('advanced')) state.difficulties.add('expert');
      else state.difficulties.delete('expert');
    }
    chip.setAttribute('aria-pressed', String(state.difficulties.has(d)));
    applyDifficultyFilter();
    renderList();
  });

  document.querySelector('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) setTab(tab.dataset.tab);
  });
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
    const i = tabs.findIndex((t) => t.dataset.tab === state.tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    setTab(next.dataset.tab);
  });

  $('search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.item');
    if (!btn) return;
    const entry = pisteById.get(btn.dataset.id) || liftById.get(btn.dataset.id);
    if (entry) select(entry);
  });
  list.addEventListener('mouseover', (e) => {
    const btn = e.target.closest('.item');
    const entry = btn && (pisteById.get(btn.dataset.id) || liftById.get(btn.dataset.id));
    highlight('hover-glow', entry || null);
  });
  list.addEventListener('mouseleave', () => highlight('hover-glow', null));

  $('panel-handle').addEventListener('click', () => {
    const open = panel.dataset.state !== 'open';
    panel.dataset.state = open ? 'open' : 'peek';
    $('panel-handle').setAttribute('aria-expanded', String(open));
  });
  document.querySelector('.panel-head').addEventListener('click', () => {
    if (isMobile() && panel.dataset.state === 'peek') {
      panel.dataset.state = 'open';
      $('panel-handle').setAttribute('aria-expanded', 'true');
    }
  });

  const layersPanel = $('layers');
  $('btn-layers').addEventListener('click', () => {
    layersPanel.hidden = !layersPanel.hidden;
    $('btn-layers').setAttribute('aria-expanded', String(!layersPanel.hidden));
  });
  $('basemaps').addEventListener('click', (e) => {
    const b = e.target.closest('.basemap');
    if (b) setBasemap(b.dataset.id);
  });
  for (const key of ['hillshade', 'contours', 'pistes', 'lifts', 'nordic', 'hike', 'pois']) {
    $(`opt-${key}`).addEventListener('change', (e) => {
      state.toggles[key] = e.target.checked;
      setGroupVisibility(key, e.target.checked);
      savePrefs();
    });
  }
  $('opt-terrain').addEventListener('change', (e) => setTerrain(e.target.checked));
  $('opt-exaggeration').addEventListener('input', (e) => {
    state.exaggeration = Number(e.target.value);
    $('exaggeration-value').textContent = `×${nf1.format(state.exaggeration)}`;
    if (state.toggles.terrain) map.setTerrain({ source: 'terrain-dem', exaggeration: state.exaggeration });
    savePrefs();
  });

  $('btn-3d').addEventListener('click', () => {
    stopAnimations();
    const to3d = map.getPitch() < 10;
    map.easeTo({ pitch: to3d ? HOME.pitch : 0, bearing: to3d ? HOME.bearing : 0, duration: 1000 });
  });
  map.on('pitchend', () => $('btn-3d').setAttribute('aria-pressed', String(map.getPitch() >= 10)));
  $('btn-tour').addEventListener('click', toggleTour);
  $('btn-home').addEventListener('click', () => {
    stopAnimations();
    map.flyTo({ ...homeView(), duration: 1600 });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!layersPanel.hidden) {
      layersPanel.hidden = true;
      $('btn-layers').setAttribute('aria-expanded', 'false');
      $('btn-layers').focus();
    } else if (!details.hidden) {
      select(null);
    } else {
      stopAnimations();
    }
  });

  // ------------------------------------------------------------------ Démarrage
  renderFacts();
  renderDifficultyChips();
  renderLayersPanel();
  setTab('pistes');
  map.on('load', () => {
    applyDifficultyFilter();
    if (!sharedView) map.jumpTo(homeView());
    if (isMobile()) document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  });
}());
