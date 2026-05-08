import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const DEFAULT_RADIUS_METERS = 1000;
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS || 24);
const CACHE_TTL_MS = CACHE_TTL_HOURS * 60 * 60 * 1000;
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const OVERPASS_URLS = [
  OVERPASS_URL,
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 25000;
const ENABLE_GOOGLE_PLACES = process.env.ENABLE_GOOGLE_PLACES === 'true';
const GOOGLE_PLACES_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const GOOGLE_PLACES_TIMEOUT_MS = 20000;

const BUSINESS_CATEGORIES = {
  grocery: {
    label: 'Grocery / Daily Needs',
    googleTypes: ['grocery_store', 'supermarket', 'convenience_store'],
    tags: {
      shop: ['supermarket', 'convenience', 'grocery', 'general', 'department_store'],
    },
  },
  pharmacy: {
    label: 'Pharmacy',
    googleTypes: ['pharmacy', 'drugstore'],
    tags: {
      amenity: ['pharmacy'],
      shop: ['chemist'],
    },
  },
  cafe: {
    label: 'Cafe',
    googleTypes: ['cafe', 'coffee_shop'],
    tags: {
      amenity: ['cafe'],
    },
  },
  restaurant: {
    label: 'Restaurant / Food',
    googleTypes: ['restaurant', 'fast_food_restaurant', 'food_court'],
    tags: {
      amenity: ['restaurant', 'fast_food', 'food_court'],
    },
  },
  stationery: {
    label: 'Stationery / Books',
    googleTypes: ['book_store'],
    tags: {
      shop: ['stationery', 'books'],
    },
  },
  fitness: {
    label: 'Fitness / Wellness',
    googleTypes: ['gym', 'fitness_center', 'wellness_center', 'beauty_salon'],
    tags: {
      leisure: ['fitness_centre', 'sports_centre'],
      shop: ['beauty', 'hairdresser'],
    },
  },
};

const GOOGLE_INSTITUTION_TYPES = ['school', 'university', 'hospital', 'doctor', 'bank'];
const GOOGLE_TRANSPORT_TYPES = ['bus_station', 'bus_stop', 'train_station', 'subway_station', 'transit_station'];

const HEATMAP_CITIES = {
  bengaluru: {
    label: 'Bengaluru',
    center: { lat: 12.9716, lng: 77.5946 },
    delta: 0.025,
  },
  delhi: {
    label: 'Delhi',
    center: { lat: 28.6139, lng: 77.2090 },
    delta: 0.03,
  },
  mumbai: {
    label: 'Mumbai',
    center: { lat: 19.0760, lng: 72.8777 },
    delta: 0.025,
  },
  hyderabad: {
    label: 'Hyderabad',
    center: { lat: 17.3850, lng: 78.4867 },
    delta: 0.025,
  },
  pune: {
    label: 'Pune',
    center: { lat: 18.5204, lng: 73.8567 },
    delta: 0.025,
  },
};

const INSTITUTION_AMENITIES = new Set([
  'school',
  'college',
  'university',
  'hospital',
  'clinic',
  'doctors',
  'bank',
]);

const TRANSPORT_AMENITIES = new Set(['bus_station']);
const TRANSPORT_HIGHWAYS = new Set(['bus_stop']);
const TRANSPORT_PUBLIC = new Set(['station', 'stop_position', 'platform']);
const TRANSPORT_RAILWAY = new Set(['station', 'subway_entrance', 'tram_stop', 'halt']);

// Middleware
app.use(cors());
app.use(express.json());

const analysisCacheSchema = new mongoose.Schema(
  {
    cacheKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    lat: {
      type: Number,
      required: true,
    },
    lng: {
      type: Number,
      required: true,
    },
    radius: {
      type: Number,
      required: true,
    },
    businessType: {
      type: String,
      required: true,
    },
    businessLabel: {
      type: String,
      required: true,
    },
    score: {
      type: Number,
      required: true,
    },
    opportunityLevel: {
      type: String,
      required: true,
    },
    analysis: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },
  },
  {
    timestamps: true,
  },
);

const AnalysisCache = mongoose.model('AnalysisCache', analysisCacheSchema);

const isValidCoordinate = (lat, lng) => (
  Number.isFinite(lat)
  && Number.isFinite(lng)
  && lat >= -90
  && lat <= 90
  && lng >= -180
  && lng <= 180
);

const normalizeRadius = (radius) => {
  if (radius === undefined || radius === null || radius === '') {
    return DEFAULT_RADIUS_METERS;
  }

  const parsedRadius = Number(radius);
  if (!Number.isFinite(parsedRadius) || parsedRadius < 100 || parsedRadius > 5000) {
    return null;
  }

  return Math.round(parsedRadius);
};

const normalizeBusinessType = (businessType) => (
  BUSINESS_CATEGORIES[businessType] ? businessType : 'grocery'
);

const isDatabaseConnected = () => mongoose.connection.readyState === 1;

const roundCoordinateForCache = (value) => Number(value.toFixed(4));

const getCacheKey = ({ businessType, lat, lng, radius }) => [
  businessType,
  radius,
  roundCoordinateForCache(lat),
  roundCoordinateForCache(lng),
].join(':');

const getCachedAnalysis = async (cacheKey) => {
  if (!isDatabaseConnected()) {
    return null;
  }

  const cached = await AnalysisCache.findOne({
    cacheKey,
    expiresAt: { $gt: new Date() },
  }).lean();

  if (!cached) {
    return null;
  }

  return {
    ...cached.analysis,
    cache: {
      status: 'hit',
      cacheKey,
      cachedAt: cached.updatedAt,
      expiresAt: cached.expiresAt,
    },
  };
};

const saveCachedAnalysis = async ({ analysis, businessType, cacheKey, lat, lng, radius }) => {
  if (!isDatabaseConnected()) {
    return;
  }

  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);
  const cachedAnalysis = {
    ...analysis,
    cache: {
      status: 'stored',
      cacheKey,
      expiresAt,
    },
  };

  await AnalysisCache.findOneAndUpdate(
    { cacheKey },
    {
      cacheKey,
      lat,
      lng,
      radius,
      businessType,
      businessLabel: analysis.businessLabel,
      score: analysis.score,
      opportunityLevel: analysis.opportunityLevel,
      analysis: cachedAnalysis,
      expiresAt,
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );
};

const matchesCategory = (tags = {}, category) => (
  Object.entries(category.tags).some(([tagKey, acceptedValues]) => (
    acceptedValues.includes(tags[tagKey])
  ))
);

const getElementName = (element) => (
  element.tags?.name
  || element.tags?.brand
  || element.tags?.operator
  || `${element.type}/${element.id}`
);

const getOverpassQuery = ({ lat, lng, radius }) => `
  [out:json][timeout:25];
  (
    node(around:${radius},${lat},${lng})["shop"];
    way(around:${radius},${lat},${lng})["shop"];
    relation(around:${radius},${lat},${lng})["shop"];

    node(around:${radius},${lat},${lng})["amenity"~"^(restaurant|fast_food|food_court|cafe|pharmacy|school|college|university|hospital|clinic|doctors|bank|bus_station)$"];
    way(around:${radius},${lat},${lng})["amenity"~"^(restaurant|fast_food|food_court|cafe|pharmacy|school|college|university|hospital|clinic|doctors|bank|bus_station)$"];
    relation(around:${radius},${lat},${lng})["amenity"~"^(restaurant|fast_food|food_court|cafe|pharmacy|school|college|university|hospital|clinic|doctors|bank|bus_station)$"];

    node(around:${radius},${lat},${lng})["leisure"~"^(fitness_centre|sports_centre)$"];
    way(around:${radius},${lat},${lng})["leisure"~"^(fitness_centre|sports_centre)$"];
    relation(around:${radius},${lat},${lng})["leisure"~"^(fitness_centre|sports_centre)$"];

    node(around:${radius},${lat},${lng})["highway"="bus_stop"];
    node(around:${radius},${lat},${lng})["public_transport"];
    node(around:${radius},${lat},${lng})["railway"~"^(station|subway_entrance|tram_stop|halt)$"];

    way(around:${radius},${lat},${lng})["building"];
    relation(around:${radius},${lat},${lng})["building"];
    way(around:${radius},${lat},${lng})["landuse"="residential"];
    relation(around:${radius},${lat},${lng})["landuse"="residential"];
  );
  out tags center;
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchOverpassDataFromUrl = async ({ lat, lng, radius, url }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'SmartBusinessLocationIntelligence/0.1',
      },
      body: new URLSearchParams({ data: getOverpassQuery({ lat, lng, radius }) }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const message = `Overpass API returned ${response.status}: ${errorText.slice(0, 300)}`;
      if (response.status === 429 || response.status === 504) {
        throw new Error(`${message}. Rate limit or server overload likely; try again after a short break.`);
      }
      throw new Error(message);
    }

    return response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Overpass API request timed out for ${url}. Try again with a smaller radius or wait a moment.`);
    }

    throw new Error(`Overpass request failed for ${url}: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
};

const fetchOverpassData = async ({ lat, lng, radius }) => {
  let lastError;

  for (const url of OVERPASS_URLS) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await fetchOverpassDataFromUrl({ lat, lng, radius, url });
      } catch (err) {
        lastError = err;
        if (attempt < 2) {
          await sleep(400);
        }
      }
    }
  }

  throw new Error(`Unable to fetch Overpass data right now. ${lastError?.message || 'Please try again later.'}`);
};

const fetchGooglePlacesByTypes = async ({ includedTypes, lat, lng, radius, maxResultCount = 20 }) => {
  if (!ENABLE_GOOGLE_PLACES || !process.env.GOOGLE_PLACES_API_KEY) {
    return [];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_PLACES_TIMEOUT_MS);

  try {
    const response = await fetch(GOOGLE_PLACES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.location',
          'places.primaryType',
          'places.types',
          'places.rating',
          'places.userRatingCount',
          'places.businessStatus',
          'places.googleMapsUri',
        ].join(','),
      },
      body: JSON.stringify({
        includedTypes,
        maxResultCount,
        rankPreference: 'POPULARITY',
        locationRestriction: {
          circle: {
            center: {
              latitude: lat,
              longitude: lng,
            },
            radius,
          },
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google Places API returned ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const data = await response.json();
    return data.places || [];
  } finally {
    clearTimeout(timeout);
  }
};

const getGooglePlaceName = (place) => place.displayName?.text || 'Unnamed place';

const formatGooglePlace = (place, categoryKey) => ({
  id: place.id,
  name: getGooglePlaceName(place),
  categoryKey,
  category: BUSINESS_CATEGORIES[categoryKey]?.label || place.primaryType || 'Place',
  primaryType: place.primaryType,
  types: place.types || [],
  rating: place.rating ?? null,
  userRatingCount: place.userRatingCount ?? 0,
  address: place.formattedAddress || '',
  businessStatus: place.businessStatus || 'UNKNOWN',
  googleMapsUri: place.googleMapsUri || '',
});

const getRatingLevel = (rating) => {
  if (!rating) {
    return 'unknown';
  }

  if (rating >= 4.2) {
    return 'strong';
  }

  if (rating >= 3.6) {
    return 'average';
  }

  return 'weak';
};

const fetchGooglePlacesIntel = async ({ lat, lng, radius }) => {
  if (!ENABLE_GOOGLE_PLACES || !process.env.GOOGLE_PLACES_API_KEY) {
    return {
      configured: false,
      status: 'osm_only',
      message: 'OSM-only mode is active. No Google Places API calls or billing are used.',
      categoryBreakdown: null,
      topCompetitors: [],
      institutions: null,
      transportPoints: null,
      ratingSummary: null,
    };
  }

  const categoryEntries = Object.entries(BUSINESS_CATEGORIES);
  const categoryResults = await Promise.all(
    categoryEntries.map(async ([key, category]) => {
      const places = await fetchGooglePlacesByTypes({
        includedTypes: category.googleTypes,
        lat,
        lng,
        radius,
      });

      return [key, places.map((place) => formatGooglePlace(place, key))];
    }),
  );

  const categoryBreakdown = Object.fromEntries(
    categoryResults.map(([key, places]) => {
      const ratedPlaces = places.filter((place) => place.rating);
      const averageRating = ratedPlaces.length
        ? Number((ratedPlaces.reduce((sum, place) => sum + place.rating, 0) / ratedPlaces.length).toFixed(1))
        : null;

      return [
        key,
        {
          label: BUSINESS_CATEGORIES[key].label,
          count: places.length,
          averageRating,
          totalReviews: places.reduce((sum, place) => sum + place.userRatingCount, 0),
          examples: places.slice(0, 3).map((place) => place.name),
        },
      ];
    }),
  );

  const topCompetitors = categoryResults
    .flatMap(([, places]) => places)
    .sort((a, b) => (b.userRatingCount - a.userRatingCount) || ((b.rating || 0) - (a.rating || 0)))
    .slice(0, 8);

  const [institutions, transport] = await Promise.all([
    fetchGooglePlacesByTypes({
      includedTypes: GOOGLE_INSTITUTION_TYPES,
      lat,
      lng,
      radius,
      maxResultCount: 20,
    }),
    fetchGooglePlacesByTypes({
      includedTypes: GOOGLE_TRANSPORT_TYPES,
      lat,
      lng,
      radius,
      maxResultCount: 20,
    }),
  ]);

  const ratedCompetitors = topCompetitors.filter((place) => place.rating);
  const averageRating = ratedCompetitors.length
    ? Number((ratedCompetitors.reduce((sum, place) => sum + place.rating, 0) / ratedCompetitors.length).toFixed(1))
    : null;

  return {
    configured: true,
    status: 'active',
    message: 'Google Places competitor intel active.',
    categoryBreakdown,
    topCompetitors,
    institutions: institutions.length,
    transportPoints: transport.length,
    ratingSummary: {
      averageRating,
      ratingLevel: getRatingLevel(averageRating),
      ratedCompetitors: ratedCompetitors.length,
      totalReviewCount: topCompetitors.reduce((sum, place) => sum + place.userRatingCount, 0),
    },
  };
};

const getDensityLevel = (count, radius, thresholds) => {
  const scale = radius / 1000;

  if (count >= thresholds.high * scale) {
    return 'high';
  }

  if (count >= thresholds.medium * scale) {
    return 'medium';
  }

  return 'low';
};

const summarizeElements = (elements, radius) => {
  const categoryBreakdown = Object.fromEntries(
    Object.entries(BUSINESS_CATEGORIES).map(([key, value]) => [
      key,
      {
        label: value.label,
        count: 0,
        examples: [],
      },
    ]),
  );

  let totalBusinesses = 0;
  let institutions = 0;
  let transportPoints = 0;
  let residentialIndicators = 0;

  for (const element of elements) {
    const tags = element.tags || {};
    let matchedBusiness = false;

    for (const [key, category] of Object.entries(BUSINESS_CATEGORIES)) {
      if (matchesCategory(tags, category)) {
        categoryBreakdown[key].count += 1;
        matchedBusiness = true;

        if (categoryBreakdown[key].examples.length < 3) {
          categoryBreakdown[key].examples.push(getElementName(element));
        }
      }
    }

    if (matchedBusiness || tags.shop) {
      totalBusinesses += 1;
    }

    if (INSTITUTION_AMENITIES.has(tags.amenity)) {
      institutions += 1;
    }

    if (
      TRANSPORT_AMENITIES.has(tags.amenity)
      || TRANSPORT_HIGHWAYS.has(tags.highway)
      || TRANSPORT_PUBLIC.has(tags.public_transport)
      || TRANSPORT_RAILWAY.has(tags.railway)
    ) {
      transportPoints += 1;
    }

    if (
      tags.landuse === 'residential'
      || ['apartments', 'residential', 'house', 'detached', 'terrace'].includes(tags.building)
    ) {
      residentialIndicators += 1;
    }
  }

  return {
    totalElements: elements.length,
    totalBusinesses,
    categoryBreakdown,
    institutions,
    transportPoints,
    residentialIndicators,
    residentialDensity: getDensityLevel(residentialIndicators, radius, { medium: 8, high: 25 }),
    competitorDensity: getDensityLevel(totalBusinesses, radius, { medium: 12, high: 35 }),
  };
};

const getDemandScore = (summary) => {
  const residentialScore = { low: 12, medium: 24, high: 36 }[summary.residentialDensity];
  const institutionScore = Math.min(summary.institutions * 4, 24);
  const transportScore = Math.min(summary.transportPoints * 5, 20);

  return {
    residentialScore,
    institutionScore,
    transportScore,
    total: Math.min(residentialScore + institutionScore + transportScore, 80),
  };
};

const getOpportunityLevel = (score) => {
  if (score >= 75) {
    return 'high';
  }

  if (score >= 55) {
    return 'medium';
  }

  return 'low';
};

const buildRecommendations = (summary, targetBusinessType) => {
  const demandBoost = (
    (summary.residentialDensity === 'high' ? 2 : summary.residentialDensity === 'medium' ? 1 : 0)
    + Math.min(summary.institutions, 6)
    + Math.min(summary.transportPoints, 4)
  );

  return Object.entries(summary.categoryBreakdown)
    .map(([key, category]) => {
      const opportunityScore = Math.max(0, Math.round((demandBoost * 8) - (category.count * 5) + 35));
      return {
        key,
        category: category.label,
        opportunityScore: Math.min(opportunityScore, 100),
        existingCount: category.count,
        averageRating: category.averageRating ?? null,
        totalReviews: category.totalReviews ?? null,
        isSelected: key === targetBusinessType,
        reason: `${category.count} existing ${category.label.toLowerCase()} places found inside this radius.`,
      };
    })
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
    .slice(0, 3);
};

const estimateFootfall = (summary, googleIntel) => {
  const total = (
    Math.min(summary.transportPoints * 3, 35)
    + Math.min(summary.institutions * 2, 25)
    + Math.min(summary.totalBusinesses, 25)
    + ({ low: 5, medium: 12, high: 20 }[summary.residentialDensity])
  );

  const level = total >= 65 ? 'high' : total >= 35 ? 'medium' : 'low';

  return {
    score: Math.min(Math.round(total), 100),
    level,
    byTimeOfDay: {
      morning: summary.transportPoints > 8 || summary.institutions > 6 ? 'medium' : 'low',
      afternoon: summary.totalBusinesses > 15 || summary.institutions > 8 ? 'medium' : 'low',
      evening: summary.transportPoints > 10 || summary.residentialDensity !== 'low' ? 'high' : 'medium',
    },
    basis: googleIntel.configured ? 'Google Places + OpenStreetMap signals' : 'OpenStreetMap signals',
  };
};

const buildAnalysis = ({ businessType, googleIntel, lat, lng, radius, elements }) => {
  const summary = summarizeElements(elements, radius);
  if (googleIntel.categoryBreakdown) {
    summary.categoryBreakdown = googleIntel.categoryBreakdown;
    summary.totalBusinesses = Object.values(googleIntel.categoryBreakdown)
      .reduce((sum, category) => sum + category.count, 0);
    summary.competitorDensity = getDensityLevel(summary.totalBusinesses, radius, { medium: 12, high: 35 });
  }

  if (Number.isFinite(googleIntel.institutions)) {
    summary.institutions = Math.max(summary.institutions, googleIntel.institutions);
  }

  if (Number.isFinite(googleIntel.transportPoints)) {
    summary.transportPoints = Math.max(summary.transportPoints, googleIntel.transportPoints);
  }

  const demandScore = getDemandScore(summary);
  const competitionPenalty = Math.min(summary.totalBusinesses * 1.2, 35);
  const baseScore = 35;
  const selectedCategory = summary.categoryBreakdown[businessType];
  const selectedCompetitionPenalty = selectedCategory
    ? Math.min(selectedCategory.count * 5, 35)
    : competitionPenalty;
  const ratingPenalty = selectedCategory?.averageRating >= 4.2 ? 8 : 0;
  const rawScore = baseScore + demandScore.total - selectedCompetitionPenalty - ratingPenalty;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const recommendations = buildRecommendations(summary, businessType);
  const opportunityLevel = getOpportunityLevel(score);
  const footfallEstimate = estimateFootfall(summary, googleIntel);
  const whyThisLocation = [
    `${summary.residentialDensity} residential density from ${summary.residentialIndicators} mapped residential signals.`,
    `${summary.institutions} nearby institutions can create repeat local demand.`,
    `${summary.transportPoints} transport points indicate movement and accessibility.`,
    `${selectedCategory?.count ?? summary.totalBusinesses} existing ${BUSINESS_CATEGORIES[businessType].label.toLowerCase()} competitors suggest ${summary.competitorDensity} competition.`,
  ];

  return {
    status: 'analyzed',
    location: { lat, lng },
    radius,
    businessType,
    businessLabel: BUSINESS_CATEGORIES[businessType].label,
    score,
    opportunityLevel,
    scoreBreakdown: {
      baseScore,
      residentialBoost: demandScore.residentialScore,
      institutionBoost: demandScore.institutionScore,
      transportBoost: demandScore.transportScore,
      demandTotal: demandScore.total,
      competitionPenalty: Math.round(selectedCompetitionPenalty),
      ratingPenalty,
      finalScore: score,
    },
    demandSignals: {
      residentialDensity: summary.residentialDensity,
      residentialIndicators: summary.residentialIndicators,
      nearbyInstitutions: summary.institutions,
      transportPoints: summary.transportPoints,
      demandScore: demandScore.total,
      footfallEstimate,
    },
    supplySignals: {
      existingCompetitors: summary.totalBusinesses,
      selectedCategoryCompetitors: selectedCategory?.count ?? 0,
      competitorDensity: summary.competitorDensity,
      categoryBreakdown: summary.categoryBreakdown,
      googlePlaces: googleIntel,
    },
    recommendations,
    whyThisLocation,
    explanation: `${BUSINESS_CATEGORIES[businessType].label} score ${score}/100 based on ${summary.residentialDensity} residential signals, ${summary.institutions} institutions, ${summary.transportPoints} transport points, and ${selectedCategory?.count ?? 0} same-category competitors in ${radius}m.`,
    dataSource: {
      provider: googleIntel.configured ? 'Google Places API + OpenStreetMap Overpass API' : 'OpenStreetMap Overpass API',
      elementsAnalyzed: summary.totalElements,
      googlePlacesStatus: googleIntel.status,
    },
  };
};

const runAnalysis = async ({ businessType, forceRefresh = false, lat, lng, radius }) => {
  const cacheKey = getCacheKey({ businessType, lat, lng, radius });

  if (!forceRefresh) {
    const cachedAnalysis = await getCachedAnalysis(cacheKey);
    if (cachedAnalysis) {
      return cachedAnalysis;
    }
  }

  const [overpassData, googleIntel] = await Promise.all([
    fetchOverpassData({ lat, lng, radius }),
    fetchGooglePlacesIntel({ lat, lng, radius }),
  ]);
  const analysis = buildAnalysis({
    businessType,
    googleIntel,
    lat,
    lng,
    radius,
    elements: overpassData.elements || [],
  });
  analysis.cache = {
    status: isDatabaseConnected() ? 'miss' : 'disabled',
    cacheKey,
    ttlHours: CACHE_TTL_HOURS,
  };

  await saveCachedAnalysis({
    analysis,
    businessType,
    cacheKey,
    lat,
    lng,
    radius,
  });

  return analysis;
};

const getHeatmapPoints = (center, delta = 0.025, isLocationSpecific = false) => {
  if (isLocationSpecific) {
    const offsets = [
      { lat: 0, lng: 0 },
      { lat: delta, lng: 0 },
      { lat: -delta, lng: 0 },
      { lat: 0, lng: delta },
      { lat: 0, lng: -delta },
    ];

    return offsets.map(({ lat, lng }) => ({
      lat: Number((center.lat + lat).toFixed(5)),
      lng: Number((center.lng + lng).toFixed(5)),
    }));
  }

  const offsets = [-1, 0, 1];

  return offsets.flatMap((latOffset) => (
    offsets.map((lngOffset) => ({
      lat: Number((center.lat + (latOffset * delta)).toFixed(5)),
      lng: Number((center.lng + (lngOffset * delta)).toFixed(5)),
    }))
  ));
};

const getNearestHeatmapCity = ({ lat, lng }) => {
  let nearestKey = 'bengaluru';
  let nearestDistance = Number.POSITIVE_INFINITY;

  Object.entries(HEATMAP_CITIES).forEach(([key, city]) => {
    const dLat = lat - city.center.lat;
    const dLng = lng - city.center.lng;
    const dist = dLat * dLat + dLng * dLng;

    if (dist < nearestDistance) {
      nearestDistance = dist;
      nearestKey = key;
    }
  });

  return nearestKey;
};

const getHeatmapColor = (score) => {
  if (score >= 75) {
    return 'green';
  }

  if (score >= 55) {
    return 'yellow';
  }

  return 'red';
};

// Routes
app.get('/api/health', (req, res) => {
  const databaseConnected = isDatabaseConnected();

  res.status(200).json({
    status: 'ok',
    message: 'Server is running!',
    database: databaseConnected ? 'connected' : 'not_connected',
    cache: databaseConnected ? 'enabled' : 'disabled_until_mongodb_connects',
  });
});

app.get('/api/analyses/recent', async (req, res) => {
  if (!isDatabaseConnected()) {
    return res.status(200).json({
      status: 'ok',
      database: 'not_connected',
      analyses: [],
    });
  }

  const analyses = await AnalysisCache.find({ expiresAt: { $gt: new Date() } })
    .sort({ updatedAt: -1 })
    .limit(8)
    .select('lat lng radius businessType businessLabel score opportunityLevel updatedAt analysis.explanation')
    .lean();

  return res.status(200).json({
    status: 'ok',
    database: 'connected',
    analyses: analyses.map((item) => ({
      id: item._id,
      lat: item.lat,
      lng: item.lng,
      radius: item.radius,
      businessType: item.businessType,
      businessLabel: item.businessLabel,
      score: item.score,
      opportunityLevel: item.opportunityLevel,
      explanation: item.analysis?.explanation || '',
      updatedAt: item.updatedAt,
    })),
  });
});

app.get('/api/heatmap/cities', (req, res) => {
  res.status(200).json({
    cities: Object.entries(HEATMAP_CITIES).map(([key, city]) => ({
      key,
      label: city.label,
      center: city.center,
    })),
  });
});

app.post('/api/heatmap', async (req, res) => {
  const businessType = normalizeBusinessType(req.body.businessType);
  const radius = normalizeRadius(req.body.radius || 500);
  const requestedLat = Number(req.body.lat);
  const requestedLng = Number(req.body.lng);
  const hasLocation = isValidCoordinate(requestedLat, requestedLng);
  const cityKey = HEATMAP_CITIES[req.body.city] ? req.body.city : (hasLocation ? getNearestHeatmapCity({ lat: requestedLat, lng: requestedLng }) : 'bengaluru');
  const city = HEATMAP_CITIES[cityKey];
  const heatmapCenter = hasLocation ? { lat: requestedLat, lng: requestedLng } : city.center;

  if (radius === null) {
    return res.status(400).json({
      status: 'error',
      message: 'Radius must be a number between 100 and 5000 meters.',
    });
  }

  const points = [];
  const errors = [];
  const isLocationSpecific = hasLocation;
  const heatmapDelta = isLocationSpecific ? 0.01 : city.delta;

  for (const point of getHeatmapPoints(heatmapCenter, heatmapDelta, isLocationSpecific)) {
    try {
      const analysis = await runAnalysis({
        businessType,
        lat: point.lat,
        lng: point.lng,
        radius,
      });

      points.push({
        lat: point.lat,
        lng: point.lng,
        score: analysis.score,
        opportunityLevel: analysis.opportunityLevel,
        color: getHeatmapColor(analysis.score),
        selectedCategoryCompetitors: analysis.supplySignals?.selectedCategoryCompetitors ?? 0,
        footfallLevel: analysis.demandSignals?.footfallEstimate?.level || 'unknown',
        cacheStatus: analysis.cache?.status || 'unknown',
      });
    } catch (err) {
      errors.push({
        lat: point.lat,
        lng: point.lng,
        message: err.message,
      });
    }
  }

  return res.status(200).json({
    status: points.length > 0 ? 'ok' : 'partial_failure',
    city: {
      key: cityKey,
      label: city.label,
      center: city.center,
    },
    businessType,
    businessLabel: BUSINESS_CATEGORIES[businessType].label,
    radius,
    points,
    errors,
    summary: {
      analyzedPoints: points.length,
      failedPoints: errors.length,
      averageScore: points.length
        ? Math.round(points.reduce((sum, point) => sum + point.score, 0) / points.length)
        : null,
      bestPoint: points.length
        ? points.reduce((best, point) => (point.score > best.score ? point : best), points[0])
        : null,
    },
  });
});

app.post('/api/analyze', async (req, res) => {
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  const radius = normalizeRadius(req.body.radius);
  const businessType = normalizeBusinessType(req.body.businessType);
  const forceRefresh = req.body.forceRefresh === true;

  if (!isValidCoordinate(lat, lng)) {
    return res.status(400).json({
      status: 'error',
      message: 'Valid lat and lng values are required.',
    });
  }

  if (radius === null) {
    return res.status(400).json({
      status: 'error',
      message: 'Radius must be a number between 100 and 5000 meters.',
    });
  }

  try {
    const analysis = await runAnalysis({
      businessType,
      forceRefresh,
      lat,
      lng,
      radius,
    });

    return res.status(200).json(analysis);
  } catch (err) {
    const message = err.name === 'AbortError'
      ? 'Overpass API timed out. Try a smaller radius or analyze again.'
      : 'Unable to fetch Overpass data right now. Please try again.';

    return res.status(502).json({
      status: 'error',
      message,
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Database connection is optional for Step 1 so the API remains usable locally.
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/location-intel')
  .then(() => {
    console.log('Connected to MongoDB');
  })
  .catch((err) => {
    console.warn('MongoDB connection unavailable. Continuing without database.');
    console.warn(err.message);
  });
