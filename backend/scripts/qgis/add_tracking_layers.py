"""
Adds the tracking layers to the open QGIS project with the SAME heights as the web preview
(docs/CAMPUS_3D_PREVIEW_PLAN.md). Run in QGIS: Plugins > Python Console > Show Editor > open this file > Run.
Run `npm run qgis:sync -- --dir=<campus_3d>` first so the project's terrain and buildings are the server ones.

Layers come from the PostGIS views in schema "qgis" (Z = orthometric / MSL on EPSG:5186):
  qgis.fused_positions (filtered to one algorithm version), qgis.event_markers, qgis.location_samples (off),
  qgis.canonical_points (off). 3D altitude clamping is Absolute: the stored Z is drawn as is.
Do NOT use the raw tables public.fused_positions / location_samples in 3D: their geom Z is the WGS84
ellipsoidal height (~23.4 m higher), which puts the track one building above the ground.
"""
from qgis.core import QgsProject, QgsVectorLayer, QgsDataSourceUri, Qgis
from qgis._3d import QgsPoint3DSymbol, QgsVectorLayer3DRenderer, QgsPhongMaterialSettings
from qgis.PyQt.QtGui import QColor
from pathlib import Path


def _db_from_env():
    """Connection from the repo's root .env (POSTGRES_DB/USER/PASSWORD/PORT), defaults as in .env.example."""
    env = {}
    try:
        here = Path(__file__).resolve()
    except NameError:  # QGIS console editor may not define __file__
        here = Path('/Users/hoshi/Documents/CampusTracker-Server/backend/scripts/qgis/add_tracking_layers.py')
    path = here.parents[3] / '.env'
    if path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    return dict(host='localhost', port=env.get('POSTGRES_PORT', '5432'), dbname=env.get('POSTGRES_DB', 'campus'),
                user=env.get('POSTGRES_USER', 'campus'), password=env.get('POSTGRES_PASSWORD', 'campus'))


DB = _db_from_env()
VERSION = 'fusion-v4'
SESSION = ''  # optional: one session id, e.g. 'fbaa781d-6065-4475-b95c-35531cee53c2'
GROUP = 'Tracking (MSL, web preview heights)'


def layer(view, name, key, where, color, radius, visible=True):
    uri = QgsDataSourceUri()
    uri.setConnection(DB['host'], DB['port'], DB['dbname'], DB['user'], DB['password'])
    uri.setDataSource('qgis', view, 'geom', where, key)
    lyr = QgsVectorLayer(uri.uri(False), name, 'postgres')
    if not lyr.isValid():
        raise RuntimeError(f'{view}: layer not valid (is the database running and migrated?)')
    sym = QgsPoint3DSymbol()
    sym.setShape(Qgis.Point3DShape.Sphere)
    sym.setShapeProperties({'radius': radius})
    sym.setAltitudeClamping(Qgis.AltitudeClamping.Absolute)
    mat = QgsPhongMaterialSettings()
    mat.setDiffuse(QColor(color))
    mat.setAmbient(QColor(color).darker(150))
    sym.setMaterialSettings(mat)
    lyr.setRenderer3D(QgsVectorLayer3DRenderer(sym))
    lyr.renderer().symbol().setColor(QColor(color))
    project = QgsProject.instance()
    project.addMapLayer(lyr, False)
    root = project.layerTreeRoot()
    group = root.findGroup(GROUP) or root.insertGroup(0, GROUP)
    node = group.addLayer(lyr)
    node.setItemVisibilityChecked(visible)
    return lyr


def add_tracking_layers():
    session = f" AND session_id = '{SESSION}'" if SESSION else ''
    session_only = f"session_id = '{SESSION}'" if SESSION else ''
    out = [
        layer('fused_positions', f'Fused track · {VERSION}', 'id', f"algorithm_version = '{VERSION}'" + session, '#2563eb', 0.6),
        layer('event_markers', 'Markers (snapped to fusion-v4)', 'id', session_only, '#f97316', 0.9),
        layer('location_samples', 'Raw GPS (phone MSL altitude)', 'id', session_only, '#9ca3af', 0.5, visible=False),
        layer('canonical_points', 'Canonical paths (Lab)', 'id', '', '#16a34a', 0.5, visible=False),
    ]
    print('added:', ', '.join(f'{l.name()} ({l.featureCount()})' for l in out))
    return out


if __name__ in ('__main__', '__console__'):
    add_tracking_layers()
