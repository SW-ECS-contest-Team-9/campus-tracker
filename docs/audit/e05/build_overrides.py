"""E05: results.json 의 은주관 부분과 공연실습소 숨김을 건물 보정 파일에 써 넣는다(문예관 지붕 항목은 그대로 둔다).

  python build_overrides.py <results.json> <backend/data/scene/overrides/building-roofs.json>
"""
import json, sys, pathlib
res = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
path = pathlib.Path(sys.argv[2])
doc = json.loads(path.read_text(encoding='utf-8'))
A, B = res['A_은주관'], res['B_공연실습소']
IDS = {'은주1관': ('1관', '은주1관'), '은주2관': ('2관', '은주2관'), '은주2관 낮은 단': ('2관-낮은단', None), '탑': ('탑', None), '접합부': ('접합부', None),
       '접합부 남서 날개': ('접합부-남서날개', None), '동쪽 끝 높은 부분': ('동쪽끝-높은부분', None), '동쪽 끝 낮은 부분': ('동쪽끝-낮은부분', None), '동쪽 끝 남쪽 날개': ('동쪽끝-남쪽날개', None)}
order = ['은주1관', '은주2관', '은주2관 낮은 단', '탑', '접합부', '접합부 남서 날개', '동쪽 끝 높은 부분', '동쪽 끝 낮은 부분', '동쪽 끝 남쪽 날개']
P = {a['part']: a for a in A['parts']}
f, m, r = A['footprint'], B['meshOn혜인관'], B['register53636']

doc['about'] = ('Overrides applied by scripts/scene-import.ts (see src/modules/scene/scene-overrides.ts): "buildings" = roof elevation of one building, '
                '"hidden" = a GeoPackage building that is not drawn, "parts" = one footprint drawn as several flat-roofed blocks. Remove an entry, or import '
                'with --no-overrides, to get the GeoPackage model back. S-MAP is not an independent survey: values here agree with S-MAP, not with a field measurement.')
doc['hidden'] = [{
    'name': '공연실습소',
    'reason': 'The polygon carrying the register record 53636 (공연실습소) lies on 혜인관 and is not the 공연실습소 building; the real building is elsewhere (user, 2026-10-10). Its location is not in the campus map yet, so nothing is drawn for it.',
    'evidence': {
        'source': 'user statement 2026-10-10; register AL_D010 record 53636; S-MAP 3D viewer building model, 2 m grid',
        'collectedOn': '2026-10-10', 'level': 'user-confirmed fact, supported by source data', 'independentSurvey': False,
        'register': f"record 53636 states footprint {float(r['footprintM2']):.2f} m2, its polygon is {r['polygonAreaM2']} m2 and {round(r['overlapWith42232']['shareOf53636'] * 100)} % of it lies on the 혜인관 polygon 42232",
        'mesh': f"{m['under53636(공연실습소 표기 도형)']['models'][str(m['modelId'])]} of {m['under53636(공연실습소 표기 도형)']['cells']} grid cells under the polygon are the single S-MAP 혜인관 model (roof median {m['under53636(공연실습소 표기 도형)']['buildingZ']['median']} m); the {m['in53636notIn42232']['cells']} cells outside the 혜인관 polygon are open ground ({m['in53636notIn42232']['terrainZ']['median']} m). No second volume",
        'notCovered': 'the real 공연실습소 (user-marked cluster south-west of 유담관, outside the campus map footprints); campus_buildings still has this polygon as building id 혜인관',
        'reproduce': 'docs/audit/e05/analyze.py -> docs/audit/e05/results.json (B_공연실습소)',
    },
}]
doc['parts'] = [{
    'name': '은주관',
    'heightSource': 'SMAP_MESH',
    'evidence': {
        'source': 'S-MAP 3D viewer building model surface picks, 1 m grid',
        'collectedOn': '2026-10-10', 'level': 'source data (one provider), not field verified; part boundaries read from the grid (+-0.5 m)', 'independentSurvey': False,
        'footprint': f"unchanged: {f['ofThemBuildingModel']} of {f['gridCellsInsideOutline']} grid cells inside the source footprint are the S-MAP building model, {f['modelCellsOutside']} model cells lie outside (max {f['modelCellsOutsideMaxDistM']} m)",
        'roofs': 'each part is a flat block at the median of the S-MAP model cells inside it. ' + '; '.join(
            f"{IDS[n][0]}: {P[n]['chosenFlatRoofM']} (p10-p90 {P[n]['meshRoof']['p10']}-{P[n]['meshRoof']['p90']}, {P[n]['buildingModelCells']} cells, {round(P[n]['cellsWithin1_5m'] * 100)} % within 1.5 m)" for n in order),
        'roofForm': '1관: gable in the S-MAP model, eaves 155.3 m, ridge 157.9 m. 2관: one plane rising from 158.3 m (south-west) to 161.3 m at the field edge, beside a 146.8 m flat strip 7 m wide on the south-west side. Tower: 162.5 m flat top, radius 4.8 m, drawn as a 24-gon. Dormers, the antenna mast and roof slopes are not modelled',
        'replaces': f"one block, roof {A['current']['roofM']} m (register height 25.5 m on the server DEM median); that is {min(a['currentMinusMeshMedianM'] for a in A['parts'])}-{max(a['currentMinusMeshMedianM'] for a in A['parts'])} m above the parts",
        'notCovered': 'ground heights (S-MAP: field side 148.9 m, west of 1관 127-135 m, south-west of 2관 132.1 m; the server DEM has 141-144 m here), bases, floors, vertical datum of S-MAP',
        'reproduce': 'docs/audit/e05/analyze.py + eunju_parts.py -> docs/audit/e05/results.json (A_은주관); this block is written by docs/audit/e05/build_overrides.py',
    },
    'parts': [{'id': IDS[n][0], 'name': IDS[n][1], 'roofM': P[n]['chosenFlatRoofM'], 'polygon': P[n]['polygon5186']} for n in order],
}]
text = json.dumps(doc, ensure_ascii=False, indent=2)
# each ring on one line (the file is read by people)
import re
text = re.sub(r'\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]', r'[\1, \2]', text)
text = re.sub(r'\],\s+\[(?=\d)', '], [', text)
path.write_text(text + '\n', encoding='utf-8', newline='\n')
print('hidden', len(doc['hidden']), 'parts', len(doc['parts'][0]['parts']))
