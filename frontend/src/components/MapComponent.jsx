import React, { useEffect, useMemo, useState } from 'react';
import { CircleMarker, MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

import L from 'leaflet';
import icon from 'leaflet/dist/images/marker-icon.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';

const DefaultIcon = L.icon({
  iconUrl: icon,
  shadowUrl: iconShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});
L.Marker.prototype.options.icon = DefaultIcon;

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';
const INDIA_CENTER = [20.5937, 78.9629];
const DEFAULT_RADIUS = 1000;
const HEATMAP_RADIUS = 500;
const BUSINESS_OPTIONS = [
  { value: 'grocery', label: 'Grocery / Daily Needs' },
  { value: 'pharmacy', label: 'Pharmacy' },
  { value: 'cafe', label: 'Cafe' },
  { value: 'restaurant', label: 'Restaurant / Food' },
  { value: 'stationery', label: 'Stationery / Books' },
  { value: 'fitness', label: 'Fitness / Wellness' },
];
const CITY_OPTIONS = [
  { value: 'bengaluru', label: 'Bengaluru' },
  { value: 'delhi', label: 'Delhi' },
  { value: 'mumbai', label: 'Mumbai' },
  { value: 'hyderabad', label: 'Hyderabad' },
  { value: 'pune', label: 'Pune' },
];

const HEATMAP_CITY_CENTERS = {
  bengaluru: { lat: 12.9716, lng: 77.5946 },
  delhi: { lat: 28.6139, lng: 77.2090 },
  mumbai: { lat: 19.0760, lng: 72.8777 },
  hyderabad: { lat: 17.3850, lng: 78.4867 },
  pune: { lat: 18.5204, lng: 73.8567 },
};

const getNearestHeatmapCity = ({ lat, lng }) => {
  let nearestCity = 'bengaluru';
  let smallestDistance = Number.POSITIVE_INFINITY;

  Object.entries(HEATMAP_CITY_CENTERS).forEach(([key, center]) => {
    const dLat = lat - center.lat;
    const dLng = lng - center.lng;
    const distance = dLat * dLat + dLng * dLng;

    if (distance < smallestDistance) {
      smallestDistance = distance;
      nearestCity = key;
    }
  });

  return nearestCity;
};

const formatLevel = (value) => {
  if (!value) {
    return 'Unknown';
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
};

const getLevelStyles = (level) => {
  if (level === 'high') {
    return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  }

  if (level === 'medium') {
    return 'bg-amber-100 text-amber-800 border-amber-200';
  }

  return 'bg-rose-100 text-rose-800 border-rose-200';
};

const getHeatmapPathOptions = (color) => {
  const colors = {
    green: { color: '#047857', fillColor: '#10b981' },
    red: { color: '#be123c', fillColor: '#fb7185' },
    yellow: { color: '#b45309', fillColor: '#f59e0b' },
  };

  return {
    ...(colors[color] || colors.yellow),
    fillOpacity: 0.48,
    opacity: 0.95,
    weight: 2,
  };
};

function MapFocus({ position }) {
  const map = useMap();

  useEffect(() => {
    if (position) {
      map.flyTo(position, Math.max(map.getZoom(), 13), { duration: 0.8 });
    }
  }, [map, position]);

  return null;
}

function LocationMarker({ position, onSelect }) {
  useMapEvents({
    click(e) {
      onSelect(e.latlng);
    },
  });

  return position === null ? null : (
    <Marker position={position}>
      <Popup>
        Selected Location <br />
        Lat: {position.lat.toFixed(4)}, Lng: {position.lng.toFixed(4)}
      </Popup>
    </Marker>
  );
}

const MapComponent = () => {
  const [position, setPosition] = useState(null);
  const [radius, setRadius] = useState(DEFAULT_RADIUS);
  const [businessType, setBusinessType] = useState('grocery');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState('');
  const [recentAnalyses, setRecentAnalyses] = useState([]);
  const [recentStatus, setRecentStatus] = useState('loading');
  const [heatmapCity, setHeatmapCity] = useState('bengaluru');
  const [heatmap, setHeatmap] = useState(null);
  const [isHeatmapLoading, setIsHeatmapLoading] = useState(false);
  const [heatmapError, setHeatmapError] = useState('');
  const [compareItems, setCompareItems] = useState([]);

  const heatmapCenterPosition = useMemo(() => {
    if (!heatmap) {
      return null;
    }

    return [heatmap.city.center.lat, heatmap.city.center.lng];
  }, [heatmap]);

  const selectedPositionLabel = useMemo(() => {
    if (!position) {
      return 'No location selected';
    }

    return `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`;
  }, [position]);

  const selectLocation = (nextPosition) => {
    const nearestCity = getNearestHeatmapCity(nextPosition);
    setHeatmapCity(nearestCity);
    setPosition(nextPosition);
    setAnalysis(null);
    setAnalyzeError('');
  };

  useEffect(() => {
    if (position) {
      loadCityHeatmap();
    }
  }, [position, heatmapCity]);

  const fetchRecentAnalyses = async () => {
    setRecentStatus('loading');

    try {
      const response = await fetch(`${API_BASE_URL}/api/analyses/recent`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Unable to load recent analyses.');
      }

      setRecentAnalyses(data.analyses || []);
      setRecentStatus(data.database === 'connected' ? 'ready' : 'database_offline');
    } catch {
      setRecentAnalyses([]);
      setRecentStatus('error');
    }
  };

  useEffect(() => {
    fetchRecentAnalyses();
  }, []);

  const handleSearch = async (event) => {
    event.preventDefault();

    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery) {
      setSearchError('Enter a place name to search.');
      return;
    }

    setIsSearching(true);
    setSearchError('');

    try {
      const params = new URLSearchParams({
        q: trimmedQuery,
        format: 'jsonv2',
        addressdetails: '1',
        limit: '5',
        countrycodes: 'in',
      });

      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Place search failed.');
      }

      const results = await response.json();
      setSearchResults(results);

      if (results.length === 0) {
        setSearchError('No matching places found in India.');
      }
    } catch (error) {
      setSearchError(error.message || 'Unable to search right now.');
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const selectSearchResult = (result) => {
    selectLocation({
      lat: Number(result.lat),
      lng: Number(result.lon),
    });
    setSearchResults([]);
    setSearchQuery(result.display_name);
  };

  const analyzeArea = async () => {
    if (!position) {
      setAnalyzeError('Select a location before analysis.');
      return;
    }

    setIsAnalyzing(true);
    setAnalyzeError('');
    setAnalysis(null);

    try {
      const response = await fetch(`${API_BASE_URL}/api/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lat: position.lat,
          lng: position.lng,
          radius,
          businessType,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Area analysis failed.');
      }

      setAnalysis(data);
      fetchRecentAnalyses();
    } catch (error) {
      setAnalyzeError(error.message || 'Unable to analyze this area.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const loadCityHeatmap = async () => {
    setIsHeatmapLoading(true);
    setHeatmapError('');

    try {
      const payload = {
        city: heatmapCity,
        businessType,
        radius: HEATMAP_RADIUS,
      };

      if (position) {
        payload.lat = position.lat;
        payload.lng = position.lng;
      }

      const response = await fetch(`${API_BASE_URL}/api/heatmap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Unable to load heatmap.');
      }

      setHeatmap(data);
      fetchRecentAnalyses();
    } catch (error) {
      setHeatmapError(error.message || 'Unable to load heatmap.');
    } finally {
      setIsHeatmapLoading(false);
    }
  };

  const addToCompare = () => {
    if (!analysis) {
      return;
    }

    setCompareItems((items) => {
      const nextItem = {
        id: `${analysis.businessType}:${analysis.radius}:${analysis.location.lat}:${analysis.location.lng}`,
        businessLabel: analysis.businessLabel,
        lat: analysis.location.lat,
        lng: analysis.location.lng,
        radius: analysis.radius,
        score: analysis.score,
        opportunityLevel: analysis.opportunityLevel,
        competitors: analysis.supplySignals?.selectedCategoryCompetitors ?? 0,
        footfall: analysis.demandSignals?.footfallEstimate?.level || 'unknown',
        residential: analysis.demandSignals?.residentialDensity || 'unknown',
      };
      const filtered = items.filter((item) => item.id !== nextItem.id);
      return [nextItem, ...filtered].slice(0, 3);
    });
  };

  const printReport = () => {
    window.print();
  };

  const loadRecentAnalysis = async (item) => {
    const nextPosition = {
      lat: item.lat,
      lng: item.lng,
    };

    setPosition(nextPosition);
    setRadius(item.radius);
    setBusinessType(item.businessType);
    setIsAnalyzing(true);
    setAnalyzeError('');
    setAnalysis(null);

    try {
      const response = await fetch(`${API_BASE_URL}/api/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lat: item.lat,
          lng: item.lng,
          radius: item.radius,
          businessType: item.businessType,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Unable to load cached analysis.');
      }

      setAnalysis(data);
    } catch (error) {
      setAnalyzeError(error.message || 'Unable to load cached analysis.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="grid min-h-[720px] grid-cols-1 overflow-hidden rounded-lg border border-slate-200 bg-white lg:grid-cols-[minmax(0,1.45fr)_minmax(360px,0.85fr)]">
      <section className="relative min-h-[520px] bg-slate-100">
        <div className="absolute left-4 right-4 top-4 z-[1000] max-w-2xl">
          <form onSubmit={handleSearch} className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-lg sm:flex-row">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              placeholder="Search a city, market, or locality"
              type="search"
            />
            <button
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
              disabled={isSearching}
              type="submit"
            >
              {isSearching ? 'Searching...' : 'Search'}
            </button>
          </form>

          {(searchError || searchResults.length > 0) && (
            <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
              {searchError && (
                <p className="px-3 py-2 text-sm text-red-600">{searchError}</p>
              )}
              {searchResults.map((result) => (
                <button
                  className="block w-full border-t border-slate-100 px-3 py-2 text-left text-sm text-slate-700 transition first:border-t-0 hover:bg-slate-50"
                  key={result.place_id}
                  onClick={() => selectSearchResult(result)}
                  type="button"
                >
                  {result.display_name}
                </button>
              ))}
            </div>
          )}
          <p className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
            Click anywhere on the map to build a heatmap at that location.
          </p>
        </div>

        <MapContainer
          center={INDIA_CENTER}
          zoom={5}
          scrollWheelZoom={true}
          className="h-full min-h-[720px] w-full"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapFocus position={position ? [position.lat, position.lng] : heatmapCenterPosition} />
          {(heatmap?.points || []).map((point) => (
            <CircleMarker
              center={[point.lat, point.lng]}
              key={`${point.lat}:${point.lng}`}
              pathOptions={getHeatmapPathOptions(point.color)}
              radius={18}
            >
              <Popup>
                <strong>{heatmap.businessLabel}</strong><br />
                Score: {point.score}/100<br />
                Competitors: {point.selectedCategoryCompetitors}<br />
                Footfall: {formatLevel(point.footfallLevel)}
              </Popup>
            </CircleMarker>
          ))}
          <LocationMarker position={position} onSelect={selectLocation} />
        </MapContainer>
      </section>

      <aside className="flex max-h-[720px] flex-col overflow-y-auto border-t border-slate-200 bg-slate-50 p-4 lg:border-l lg:border-t-0">
        <ControlPanel
          analyzeArea={analyzeArea}
          analyzeError={analyzeError}
          isAnalyzing={isAnalyzing}
          position={position}
          radius={radius}
          businessType={businessType}
          heatmapCity={heatmapCity}
          heatmapError={heatmapError}
          isHeatmapLoading={isHeatmapLoading}
          loadCityHeatmap={loadCityHeatmap}
          selectedPositionLabel={selectedPositionLabel}
          setHeatmapCity={setHeatmapCity}
          setRadius={setRadius}
          setBusinessType={setBusinessType}
        />

        {analysis ? (
          <AnalysisDashboard
            addToCompare={addToCompare}
            analysis={analysis}
            printReport={printReport}
          />
        ) : (
          <EmptyState isAnalyzing={isAnalyzing} />
        )}

        {heatmap && <HeatmapSummary heatmap={heatmap} />}

        <ComparePanel
          items={compareItems}
          onClear={() => setCompareItems([])}
        />

        <RecentAnalyses
          analyses={recentAnalyses}
          onSelect={loadRecentAnalysis}
          status={recentStatus}
        />
      </aside>
    </div>
  );
};

function ControlPanel({
  analyzeArea,
  analyzeError,
  heatmapCity,
  heatmapError,
  isAnalyzing,
  isHeatmapLoading,
  loadCityHeatmap,
  position,
  radius,
  businessType,
  selectedPositionLabel,
  setHeatmapCity,
  setRadius,
  setBusinessType,
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected location</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{selectedPositionLabel}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${position ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
          {position ? 'Ready' : 'Pick point'}
        </span>
      </div>

      <label className="mt-4 block text-xs font-semibold text-slate-600" htmlFor="radius">
        Business category
      </label>
      <select
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        id="businessType"
        onChange={(event) => setBusinessType(event.target.value)}
        value={businessType}
      >
        {BUSINESS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>

      <label className="mt-4 block text-xs font-semibold text-slate-600" htmlFor="radius">
        Analysis radius
      </label>
      <select
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        id="radius"
        onChange={(event) => setRadius(Number(event.target.value))}
        value={radius}
      >
        <option value={500}>500 m</option>
        <option value={1000}>1 km</option>
        <option value={2000}>2 km</option>
      </select>

      <button
        className="mt-4 w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
        disabled={isAnalyzing}
        onClick={analyzeArea}
        type="button"
      >
        {isAnalyzing ? 'Analyzing live map data...' : 'Analyze Area'}
      </button>

      {analyzeError && (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{analyzeError}</p>
      )}

      <div className="mt-4 border-t border-slate-100 pt-4">
        <label className="block text-xs font-semibold text-slate-600" htmlFor="heatmapCity">
          Heatmap target city
        </label>
        <select
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          id="heatmapCity"
          onChange={(event) => setHeatmapCity(event.target.value)}
          value={heatmapCity}
        >
          {CITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <button
          className="mt-3 w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
          disabled={isHeatmapLoading}
          onClick={loadCityHeatmap}
          type="button"
        >
          {isHeatmapLoading ? 'Updating heatmap...' : 'Refresh heatmap at selected point'}
        </button>
        {heatmapError && (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{heatmapError}</p>
        )}
      </div>
    </div>
  );
}

function EmptyState({ isAnalyzing }) {
  return (
    <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-white p-5">
      <p className="text-sm font-semibold text-slate-800">
        {isAnalyzing ? 'Reading nearby map signals...' : 'Opportunity dashboard will appear here'}
      </p>
      <p className="mt-2 text-sm text-slate-500">
        Select a point on the map, choose a radius, then analyze to see demand, competition, and business category recommendations.
      </p>
    </div>
  );
}

function RecentAnalyses({ analyses, onSelect, status }) {
  const statusText = {
    database_offline: 'MongoDB is offline, so recent analyses are not saved yet.',
    error: 'Recent analyses could not be loaded.',
    loading: 'Loading recent analyses...',
    ready: 'Saved from MongoDB cache',
  }[status];

  return (
    <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-slate-900">Recent analyses</p>
        <span className="text-xs font-semibold text-slate-500">{statusText}</span>
      </div>

      {analyses.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">
          Analyze a location while MongoDB is connected to save it here.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {analyses.map((item) => (
            <button
              className="block w-full rounded-lg border border-slate-100 bg-slate-50 p-3 text-left transition hover:border-blue-200 hover:bg-blue-50"
              key={item.id}
              onClick={() => onSelect(item)}
              type="button"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-slate-900">{item.businessLabel}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {item.lat.toFixed(4)}, {item.lng.toFixed(4)} - {item.radius} m
                  </p>
                </div>
                <span className="rounded-md bg-white px-2.5 py-1 text-xs font-bold text-slate-700">
                  {item.score}/100
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function HeatmapSummary({ heatmap }) {
  return (
    <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-slate-900">{heatmap.city.label} heatmap</p>
          <p className="mt-1 text-xs text-slate-500">{heatmap.businessLabel} - {heatmap.radius} m sample radius</p>
        </div>
        <span className="rounded-md bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-700">
          Avg {heatmap.summary.averageScore ?? 'N/A'}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <MetricCard label="Points" value={heatmap.summary.analyzedPoints} tone="slate" compact />
        <MetricCard label="Best" value={heatmap.summary.bestPoint ? heatmap.summary.bestPoint.score : 'N/A'} tone="emerald" compact />
        <MetricCard label="Failed" value={heatmap.summary.failedPoints} tone="rose" compact />
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Map dots: green high, yellow medium, red low opportunity.
      </p>
    </section>
  );
}

function ComparePanel({ items, onClear }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-slate-900">Compare locations</p>
        <button className="text-xs font-semibold text-slate-500 hover:text-slate-900" onClick={onClear} type="button">
          Clear
        </button>
      </div>
      <div className="mt-3 space-y-2">
        {items.map((item) => (
          <div className="rounded-lg border border-slate-100 bg-slate-50 p-3" key={item.id}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-slate-900">{item.businessLabel}</p>
                <p className="mt-1 text-xs text-slate-500">{item.lat.toFixed(4)}, {item.lng.toFixed(4)}</p>
              </div>
              <span className="rounded-md bg-white px-2.5 py-1 text-xs font-bold text-slate-700">{item.score}/100</span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <MetricCard label="Comp." value={item.competitors} tone="rose" compact />
              <MetricCard label="Footfall" value={formatLevel(item.footfall)} tone="amber" compact />
              <MetricCard label="Resid." value={formatLevel(item.residential)} tone="emerald" compact />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AnalysisDashboard({ addToCompare, analysis, printReport }) {
  const categories = Object.entries(analysis.supplySignals?.categoryBreakdown || {});
  const breakdown = analysis.scoreBreakdown || {};
  const levelStyles = getLevelStyles(analysis.opportunityLevel);
  const googlePlaces = analysis.supplySignals?.googlePlaces;
  const footfall = analysis.demandSignals?.footfallEstimate;

  return (
    <div className="mt-4 space-y-4">
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{analysis.businessLabel} score</p>
            <p className="mt-1 text-4xl font-bold text-slate-950">{analysis.score}/100</p>
            <span className={`mt-2 inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${levelStyles}`}>
              {formatLevel(analysis.opportunityLevel)} opportunity
            </span>
          </div>
          <ScoreRing score={analysis.score} />
        </div>
        <p className="mt-4 text-sm leading-6 text-slate-600">{analysis.explanation}</p>
        <div className="mt-4 grid grid-cols-2 gap-2 print:hidden">
          <button
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            onClick={addToCompare}
            type="button"
          >
            Add to Compare
          </button>
          <button
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
            onClick={printReport}
            type="button"
          >
            Print Report
          </button>
        </div>
        {analysis.cache && (
          <p className="mt-3 text-xs font-medium text-slate-500">
            Cache: {analysis.cache.status === 'hit' ? 'loaded from MongoDB' : analysis.cache.status === 'disabled' ? 'MongoDB not connected' : 'fresh analysis'}
          </p>
        )}
      </section>

      <section className="grid grid-cols-2 gap-3">
        <MetricCard label="Residential" value={formatLevel(analysis.demandSignals?.residentialDensity)} tone="emerald" />
        <MetricCard label="Institutions" value={analysis.demandSignals?.nearbyInstitutions ?? 0} tone="sky" />
        <MetricCard label="Transport" value={analysis.demandSignals?.transportPoints ?? 0} tone="amber" />
        <MetricCard label="Same category" value={analysis.supplySignals?.selectedCategoryCompetitors ?? 0} tone="rose" />
      </section>

      {footfall && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-slate-900">Footfall estimate</p>
              <p className="mt-1 text-sm text-slate-500">Based on nearby transport, institutions, businesses, and residential signals.</p>
            </div>
            <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${getLevelStyles(footfall.level)}`}>
              {formatLevel(footfall.level)}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <MetricCard label="Morning" value={formatLevel(footfall.byTimeOfDay?.morning)} tone="slate" compact />
            <MetricCard label="Afternoon" value={formatLevel(footfall.byTimeOfDay?.afternoon)} tone="slate" compact />
            <MetricCard label="Evening" value={formatLevel(footfall.byTimeOfDay?.evening)} tone="slate" compact />
          </div>
        </section>
      )}

      {googlePlaces?.configured && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-sm font-bold text-slate-900">Google competitor intel</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <MetricCard label="Avg rating" value={googlePlaces.ratingSummary?.averageRating ?? 'N/A'} tone="sky" compact />
            <MetricCard label="Review count" value={googlePlaces.ratingSummary?.totalReviewCount ?? 0} tone="amber" compact />
          </div>
          <div className="mt-3 space-y-2">
            {(googlePlaces.topCompetitors || []).slice(0, 5).map((competitor) => (
              <CompetitorItem competitor={competitor} key={competitor.id} />
            ))}
          </div>
        </section>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-bold text-slate-900">Why this location?</p>
        <div className="mt-3 space-y-2">
          {(analysis.whyThisLocation || []).map((reason) => (
            <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-sm text-slate-600" key={reason}>
              {reason}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-bold text-slate-900">Top missing opportunities</p>
          <span className="text-xs font-semibold text-slate-500">Ranked</span>
        </div>
        <div className="mt-3 space-y-3">
          {analysis.recommendations?.map((recommendation, index) => (
            <RecommendationItem index={index + 1} key={recommendation.key} recommendation={recommendation} />
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-bold text-slate-900">Score breakdown</p>
        <div className="mt-3 space-y-2">
          <BreakdownRow label="Base score" value={breakdown.baseScore ?? 0} />
          <BreakdownRow label="Residential boost" value={breakdown.residentialBoost ?? 0} />
          <BreakdownRow label="Institution boost" value={breakdown.institutionBoost ?? 0} />
          <BreakdownRow label="Transport boost" value={breakdown.transportBoost ?? 0} />
          <BreakdownRow label="Competition penalty" value={`-${breakdown.competitionPenalty ?? 0}`} negative />
          <BreakdownRow label="Strong rating penalty" value={`-${breakdown.ratingPenalty ?? 0}`} negative />
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-bold text-slate-900">Existing business mix</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {categories.map(([key, category]) => (
            <MetricCard key={key} label={category.label} value={category.count} tone="slate" compact />
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Source: {analysis.dataSource?.provider} ({analysis.dataSource?.elementsAnalyzed ?? 0} map elements)
        </p>
      </section>
    </div>
  );
}

function CompetitorItem({ competitor }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-slate-900">{competitor.name}</p>
          <p className="mt-1 text-xs text-slate-500">{competitor.category}</p>
        </div>
        <span className="rounded-md bg-white px-2.5 py-1 text-xs font-bold text-slate-700">
          {competitor.rating ? `${competitor.rating} star` : 'No rating'}
        </span>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {competitor.userRatingCount} reviews {competitor.address ? `- ${competitor.address}` : ''}
      </p>
      {competitor.googleMapsUri && (
        <a className="mt-2 inline-flex text-xs font-semibold text-blue-700 hover:text-blue-800" href={competitor.googleMapsUri} rel="noreferrer" target="_blank">
          Open in Google Maps
        </a>
      )}
    </div>
  );
}

function ScoreRing({ score }) {
  return (
    <div
      className="grid h-24 w-24 place-items-center rounded-full"
      style={{ background: `conic-gradient(#2563eb ${score * 3.6}deg, #e2e8f0 0deg)` }}
    >
      <div className="grid h-16 w-16 place-items-center rounded-full bg-white text-sm font-bold text-slate-900">
        {score}%
      </div>
    </div>
  );
}

function MetricCard({ compact = false, label, tone, value }) {
  const tones = {
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    rose: 'border-rose-200 bg-rose-50 text-rose-900',
    sky: 'border-sky-200 bg-sky-50 text-sky-900',
    slate: 'border-slate-200 bg-slate-50 text-slate-900',
  };

  return (
    <div className={`rounded-lg border p-3 ${tones[tone] || tones.slate}`}>
      <p className="text-xs font-medium opacity-75">{label}</p>
      <p className={`${compact ? 'text-lg' : 'text-2xl'} mt-1 font-bold`}>{value}</p>
    </div>
  );
}

function RecommendationItem({ index, recommendation }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-slate-500">#{index}</p>
          <p className="text-sm font-bold text-slate-900">{recommendation.category}</p>
        </div>
        <span className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-bold text-white">
          {recommendation.opportunityScore}
        </span>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-600">{recommendation.reason}</p>
    </div>
  );
}

function BreakdownRow({ label, negative = false, value }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className={`font-bold ${negative ? 'text-rose-700' : 'text-slate-900'}`}>{value}</span>
    </div>
  );
}

export default MapComponent;
