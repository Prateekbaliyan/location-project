# Location Project

This project demonstrates a location intelligence workflow for retail and service planning.

The system connects a browser-based map interface with backend spatial analysis to answer questions like:

- Which nearby areas have the best opportunity for a new business?
- How does local demand compare with supply for categories such as grocery, pharmacy, cafe, restaurant, stationery, and fitness?
- Which map points show the strongest potential based on footfall, competitors, and infrastructure?

The frontend allows users to select a point on the map and request analysis for that exact location. The backend translates those requests into spatial queries against OpenStreetMap/Overpass data, scores each location, and returns results that can be visualized as a heatmap.

The core concept is to combine:

- interactive map selection,
- proximity-based business category analysis,
- geometric data from OpenStreetMap,
- optional external points-of-interest intel,
- and visual heatmap feedback for site selection.
