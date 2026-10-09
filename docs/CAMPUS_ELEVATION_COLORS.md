# Campus elevation colours

The shared campus renderer used by preview and editor now has a **고도 색상** toggle at the lower right. The default is the existing appearance.

When enabled, terrain and building surfaces use one fixed height range and colour ramp. Purple is low and yellow is high. Building walls interpolate by their rendered surface elevation; roofs use their rendered elevation. This is not a colour classification by registered building height.

- The range includes finite DEM values and building bases/roofs, rounded outward to 10 m. Zoom, selection and opacity do not rescale the legend.
- The legend refers to the current model's orthometric height convention. It does not certify accuracy or resolve the existing ellipsoid/orthometric rendering convention.
- Buildings remain selectable; the selected outline turns blue. Existing opacity and label controls continue to work.
- Geometry positions, indices, API data, stored terrain and route heights are unchanged. The mode helps inspect the current model before making evidence-based corrections.

## Validation

Run `npx tsx --test frontend/test/elevation-colors.test.ts` from the repository root and `npm run build --workspace frontend`.

The tests cover a shared finite range, preservation of geometry positions/indices, altitude texture coordinates, and recreating Cesium materials for selection/opacity changes. The ramp is a data URL because Cesium's cached fabric deep-clone cannot reconstruct an HTML canvas instance.

Browser verification uses the archived campus scene and terrain grid: default mode, elevation mode, selection, opacity, restoration and repeated toggling. No operational data writes are needed to test the display.
