"""
Adds the EDITABLE mobility layers (PostGIS schema "mobility", migration 019) to the open QGIS project.
Draw corridors / open areas / portals, press "Save Layer Edits": they are stored in the DB at once and the
preview (Paths) updates by itself. Run in QGIS: Plugins > Python Console > Show Editor > open this file > Run.

  mobility.corridors  LineString  centerline of a walkway / corridor / stairs; width_m = real width (m)
  mobility.open_areas Polygon     plazas and other areas where people move freely
  mobility.portals    Point       entrances, stair start/end, elevators, junctions

Rules (checked by the database on save; QGIS shows the error and keeps your edits):
  EPSG:5186 geometry inside the campus terrain area, valid shapes, corridors >= 1 m, areas >= 4 m².
  Leave elevation_m empty for features on the ground; fill it (MSL m) for indoor / elevated ones.
Every save is logged in mobility.edits (who/when/before/after).
"""
from pathlib import Path
from qgis.core import (QgsProject, QgsVectorLayer, QgsDataSourceUri, QgsEditorWidgetSetup, QgsCategorizedSymbolRenderer,
                       QgsRendererCategory, QgsSymbol, QgsWkbTypes, QgsDefaultValue, Qgis, QgsSnappingConfig, QgsTolerance,
                       QgsPalLayerSettings, QgsVectorLayerSimpleLabeling, QgsTextFormat, QgsTextBufferSettings)
from qgis.PyQt.QtGui import QColor

GROUP = 'Mobility (editable, live in preview)'

KINDS = {
    'corridors': [('walkway', '보행로', '#0ea5e9'), ('sidewalk', '인도', '#38bdf8'), ('indoor_corridor', '실내 복도', '#8b5cf6'),
                  ('stairs', '계단', '#f97316'), ('ramp', '경사로', '#eab308'), ('crosswalk', '횡단보도', '#e2e8f0'),
                  ('road_shoulder', '도로 갓길', '#94a3b8'), ('other', '기타', '#64748b')],
    'open_areas': [('plaza', '광장', '#22c55e'), ('courtyard', '중정', '#84cc16'), ('lobby', '로비', '#a855f7'),
                   ('parking', '주차장', '#94a3b8'), ('other', '기타', '#64748b')],
    'portals': [('building_entrance', '건물 출입구', '#ef4444'), ('plaza_entrance', '광장 출입구', '#22c55e'),
                ('stair_start', '계단 시작', '#f97316'), ('stair_end', '계단 끝', '#fb923c'), ('elevator', '엘리베이터', '#a855f7'),
                ('junction', '교차점', '#0ea5e9'), ('other', '기타', '#64748b')],
}
TITLES = {'corridors': '통로 · 경로 (mobility.corridors)', 'open_areas': '광장 · 개방 공간 (mobility.open_areas)', 'portals': '출입구 · 연결점 (mobility.portals)'}


def _db_from_env():
    """Connection from the repo's root .env (POSTGRES_DB/USER/PASSWORD/PORT)."""
    env = {}
    try:
        here = Path(__file__).resolve()
    except NameError:  # the QGIS console editor may not define __file__
        here = Path('/Users/hoshi/Documents/CampusTracker-Server/backend/scripts/qgis/add_mobility_layers.py')
    path = here.parents[3] / '.env'
    if path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    return dict(host='localhost', port=env.get('POSTGRES_PORT', '5432'), dbname=env.get('POSTGRES_DB', 'campus'),
                user=env.get('POSTGRES_USER', 'campus'), password=env.get('POSTGRES_PASSWORD', 'campus'))


DB = _db_from_env()


def _layer(table):
    uri = QgsDataSourceUri()
    uri.setConnection(DB['host'], DB['port'], DB['dbname'], DB['user'], DB['password'])
    uri.setDataSource('mobility', table, 'geom', '', 'id')
    lyr = QgsVectorLayer(uri.uri(False), TITLES[table], 'postgres')
    if not lyr.isValid():
        raise RuntimeError(f'mobility.{table}: not valid (database running? npm run db:migrate?)')
    # categorized style by kind
    cats = []
    for value, label, color in KINDS[table]:
        sym = QgsSymbol.defaultSymbol(lyr.geometryType())
        sym.setColor(QColor(color))
        if lyr.geometryType() == QgsWkbTypes.LineGeometry:
            sym.setWidth(1.2)
        elif lyr.geometryType() == QgsWkbTypes.PolygonGeometry:
            sym.setOpacity(0.45)
        else:
            sym.setSize(3.2)
        cats.append(QgsRendererCategory(value, sym, label))
    lyr.setRenderer(QgsCategorizedSymbolRenderer('kind', cats))
    # form: kind as a Korean dropdown, sensible defaults, read-only bookkeeping fields
    fields = lyr.fields()
    lyr.setEditorWidgetSetup(fields.indexOf('kind'), QgsEditorWidgetSetup('ValueMap', {'map': [{label: value} for value, label, _ in KINDS[table]]}))
    lyr.setDefaultValueDefinition(fields.indexOf('kind'), QgsDefaultValue(f"'{KINDS[table][0][0]}'"))
    if table == 'corridors':
        lyr.setDefaultValueDefinition(fields.indexOf('width_m'), QgsDefaultValue('3'))
        lyr.setDefaultValueDefinition(fields.indexOf('one_way'), QgsDefaultValue('false'))
    for name in ('id', 'created_at', 'updated_at'):
        i = fields.indexOf(name)
        if i >= 0:
            lyr.setFieldEditable(i, False) if hasattr(lyr, 'setFieldEditable') else None
            form = lyr.editFormConfig()
            form.setReadOnly(i, True)
            lyr.setEditFormConfig(form)
    for name, alias in [('name', '이름'), ('kind', '종류'), ('width_m', '폭 (m)'), ('elevation_m', '높이 MSL (m, 실내만)'),
                        ('building_id', '건물'), ('floor', '층'), ('one_way', '일방통행 (그린 방향)'), ('note', '메모')]:
        i = fields.indexOf(name)
        if i >= 0:
            lyr.setFieldAlias(i, alias)
    # labels
    settings = QgsPalLayerSettings()
    settings.fieldName = 'name'
    fmt = QgsTextFormat()
    buf = QgsTextBufferSettings()
    buf.setEnabled(True)
    buf.setSize(1)
    fmt.setBuffer(buf)
    settings.setFormat(fmt)
    if lyr.geometryType() == QgsWkbTypes.LineGeometry:
        settings.placement = Qgis.LabelPlacement.Line
    lyr.setLabeling(QgsVectorLayerSimpleLabeling(settings))
    lyr.setLabelsEnabled(True)
    return lyr


def add_mobility_layers():
    project = QgsProject.instance()
    root = project.layerTreeRoot()
    group = root.findGroup(GROUP) or root.insertGroup(0, GROUP)
    out = []
    for table in ('open_areas', 'corridors', 'portals'):
        lyr = _layer(table)
        project.addMapLayer(lyr, False)
        group.insertLayer(0, lyr)
        out.append(lyr)
    # snap new vertices to existing ones (connect corridors to portals / each other) within 1 m
    snap = project.snappingConfig()
    snap.setEnabled(True)
    snap.setMode(QgsSnappingConfig.AllLayers)
    snap.setTypeFlag(Qgis.SnappingType.Vertex | Qgis.SnappingType.Segment)
    snap.setTolerance(1.0)
    snap.setUnits(QgsTolerance.ProjectUnits)
    project.setSnappingConfig(snap)
    print('added:', ', '.join(f'{l.name()} ({l.featureCount()})' for l in out))
    return out


if __name__ in ('__main__', '__console__'):
    add_mobility_layers()
