# Editor visibility and cursor directions

The editor exposes building opacity (0–100%) and a default-on **건물·지형 너머 통로 표시** switch. Both are browser display preferences. Building/terrain geometry and road XYZ remain unchanged.

The overlay draws a fixed-pixel centreline and dark edge with Cesium's public `PolylineColorAppearance.renderState`, depth testing disabled and depth writes disabled. It stays visible through opaque buildings/terrain independently of `depthFailMaterial` support. Minimum alpha is 0.55, or 0.28 for other routes when a route is selected. Explicit isolation retains its existing low alpha. Ordinary depth-tested lines, type patterns, indoor tubes and elevator shafts remain available underneath the overlay.

Cursor labels show 앞 W / 우 D / 뒤 S / 좌 A. The axes extend four projected metres from the cursor at its Z, with heading 0° north and 90° east, matching WASD movement. Labels have separate screen offsets and hide beyond 500 m to reduce crowding. Existing forward arrow and below-ground depth feedback remain.

Verification:

- `node --experimental-strip-types --test frontend/test/editor-visibility.test.ts` checks heading/height invariants, distant visibility versus explicit isolation, and actual Cesium render state.
- `npm run build -w frontend` checks TypeScript and production bundling.
- A local read-only fixture uses the preserved Bukak model and a clearly labelled **synthetic test corridor**. Compare xray on/off with opaque buildings, a 1200 m camera range, an inside camera, and opacity 35% combined with elevation colors. It does not save a road to the database.

This is a visibility aid. Seeing a line through a wall does not validate its physical position, floor number or connection. Those require the separate model/route calibration audit.
