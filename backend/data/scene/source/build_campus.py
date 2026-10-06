#!/usr/bin/env python3
"""Run with QGIS's bundled Python. Outputs a portable campus-only QGIS 3D project."""
import os
os.environ.setdefault('QT_QPA_PLATFORM','offscreen')
os.environ.setdefault('PROJ_DATA','/Applications/QGIS.app/Contents/Resources/qgis/proj')
from pathlib import Path
import json, shutil, csv
import numpy as np
from scipy.interpolate import LinearNDInterpolator
from osgeo import gdal, osr
from qgis.core import *
from qgis._3d import *
from qgis.PyQt.QtCore import QVariant
from qgis.PyQt.QtGui import QColor
from qgis.PyQt.QtXml import QDomDocument
OUT=Path(__file__).resolve().parent
SRC=OUT/'source'
REPO=Path('/Users/hoshi/Documents/CampusTracker-Server/backend/data/terrain/source')
for name in ['contours_5174.json','spots_5174.json','buildings_al_d010.json','SOURCES.json','skuniv_places.json']:
 if not (SRC/name).exists(): shutil.copy2(REPO/name,SRC/name)
for prefix in ['building','campus_area']:
 for ext in ['shp','shx','dbf','prj','cpg']:
  if not (SRC/f'{prefix}.{ext}').exists(): shutil.copy2(OUT.parent/f'{prefix}.{ext}',SRC/f'{prefix}.{ext}')
app=QgsApplication([],False); app.initQgis()
project=QgsProject.instance(); crs=QgsCoordinateReferenceSystem('EPSG:5186'); project.setCrs(crs)
project.setFileName(str(OUT/'campus_3d.qgz')); project.setFilePathStorage(Qgis.FilePathType.Relative)
project.setTitle('서경대학교 · 지형 기반 러프 3D')
read=lambda n:json.loads((SRC/n).read_text())
bld=QgsVectorLayer(str(SRC/'building.shp'),'원본 건물','ogr')
area=QgsVectorLayer(str(SRC/'campus_area.shp'),'캠퍼스 경계','ogr')
assert bld.isValid() and area.isValid()
campus=QgsGeometry.unaryUnion([f.geometry() for f in area.getFeatures()])
ext=QgsRectangle(area.extent()); ext.grow(90)
xmin=np.floor(ext.xMinimum()/2)*2; ymin=np.floor(ext.yMinimum()/2)*2
xmax=np.ceil(ext.xMaximum()/2)*2; ymax=np.ceil(ext.yMaximum()/2)*2
# Explicit seven-parameter datum transformation avoids an accidental ballpark shift.
srs=osr.SpatialReference(); srs.ImportFromProj4('+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43 +units=m +no_defs')
target=osr.SpatialReference(); target.ImportFromEPSG(5186)
srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER); target.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
transform=osr.CoordinateTransformation(srs,target)
pts=[]; heights=[]; lines=[]
for f in read('contours_5174.json')['features']:
 for run in f['runs']:
  xy=np.array([transform.TransformPoint(*p)[:2] for p in run]); lines.append((xy,f['height']))
  for a,b in zip(xy[:-1],xy[1:]):
   n=max(1,int(np.ceil(np.linalg.norm(b-a)/3)))
   sample=a+(b-a)*np.arange(n)[:,None]/n
   pts.extend(sample); heights.extend([f['height']]*n)
  pts.append(xy[-1]); heights.append(f['height'])
pts=np.array(pts); heights=np.array(heights)
unique,idx=np.unique(np.round(pts,4),axis=0,return_index=True); heights=heights[idx]; pts=unique
contour_surface=LinearNDInterpolator(pts,heights)
spots=read('spots_5174.json')['features']
spotxy=np.array([transform.TransformPoint(s['x'],s['y'])[:2] for s in spots]); spotz=np.array([s['height'] for s in spots])
residual=contour_surface(spotxy)-spotz
valid=residual[np.isfinite(residual)]
qa={'contour_only_spot_median_error_m':float(np.median(valid)), 'contour_only_spot_p90_abs_error_m':float(np.percentile(abs(valid),90)), 'validation_spots':len(valid)}
assert abs(qa['contour_only_spot_median_error_m'])<2.5 and qa['contour_only_spot_p90_abs_error_m']<5,qa
surface=LinearNDInterpolator(np.vstack([pts,spotxy]),np.r_[heights,spotz])
xs=np.arange(xmin+1,xmax,2); ys=np.arange(ymax-1,ymin,-2); X,Y=np.meshgrid(xs,ys); Z=surface(X,Y)
assert np.isfinite(Z).all(), 'DEM extent has unsupported cells'
dempath=OUT/'terrain_dem_2m.tif'
ds=gdal.GetDriverByName('GTiff').Create(str(dempath),len(xs),len(ys),1,gdal.GDT_Float32,options=['COMPRESS=LZW'])
ds.SetGeoTransform((xmin,2,0,ymax,0,-2)); ds.SetProjection(target.ExportToWkt()); ds.GetRasterBand(1).WriteArray(Z); ds.GetRasterBand(1).SetNoDataValue(-9999); ds=None
# GeoPackage layers preserve source records separately from the deduplicated model.
gpkg=OUT/'campus.gpkg'
if gpkg.exists(): gpkg.unlink()
def save(layer,name):
 options=QgsVectorFileWriter.SaveVectorOptions(); options.driverName='GPKG'; options.layerName=name
 if gpkg.exists():options.actionOnExistingFile=QgsVectorFileWriter.CreateOrOverwriteLayer
 result=QgsVectorFileWriter.writeAsVectorFormatV3(layer,str(gpkg),project.transformContext(),options)
 assert result[0]==QgsVectorFileWriter.NoError,result
 return QgsVectorLayer(str(gpkg)+'|layername='+name,layer.name(),'ogr')
raw=save(bld,'source_buildings'); area=save(area,'campus_boundary')
contours=QgsVectorLayer('LineString?crs=EPSG:5186&field=elevation_m:double','등고선 · 원자료','memory')
fs=[]
for xy,z in lines:
 g=QgsGeometry.fromPolylineXY([QgsPointXY(*p) for p in xy]); g=g.intersection(QgsGeometry.fromRect(ext))
 if g.isEmpty():continue
 for part in g.asGeometryCollection() if g.isMultipart() else [g]:
  f=QgsFeature(contours.fields()); f.setGeometry(part); f.setAttributes([z]); fs.append(f)
contours.dataProvider().addFeatures(fs); contours=save(contours,'contours')
model=QgsVectorLayer('MultiPolygon?crs=EPSG:5186','캠퍼스 건물 · 3D','memory')
fields=[('name',QVariant.String),('source_fid',QVariant.Int),('height_m',QVariant.Double),('height_source',QVariant.String),('register_id',QVariant.String),('ground_floors',QVariant.Int),('base_m',QVariant.Double),('roof_m',QVariant.Double),('extrusion_m',QVariant.Double),('terrain_min',QVariant.Double),('terrain_max',QVariant.Double),('note',QVariant.String)]
model.dataProvider().addAttributes([QgsField(n,t) for n,t in fields]); model.updateFields()
register=[]
for r in read('register_original_clip.geojson')['features']:
 a=r['properties']; attr={'sourceId':str(a['A0']),'name':a['A24'] or '', 'dongName':a['A25'] or '', 'heightM':a['A16'] or 0,'groundFloors':a['A26'] or 0}
 register.append((QgsGeometry.fromWkt(__import__('osgeo.ogr',fromlist=['']).CreateGeometryFromJson(json.dumps(r['geometry'])).ExportToWkt()),attr))
# These are rough placeholders, not surveyed heights. Known occupied floors are lower bounds only.
estimates={'청운관':(21,6),'문예관':(14,4),'북악관':(30.51,9),'대일관':(17.5,5),'수인관':(14,4),'상승관':(7,2)}
records=[]; features=[]; allb=list(bld.getFeatures()); skipped=[]
for f in allb:
 name=str(f['건물명']); g=f.geometry()
 if f.id()==0: name='공연실습소'
 if f.id()==4: name='혜인관'
 assert g.isGeosValid()
 assert campus.intersects(g)
 matches=[]
 for rg,attr in register:
  overlap=g.intersection(rg).area()/g.area()
  if overlap>.5 and float(attr['heightM'])>0:
   name_match=name in (attr['name']+attr['dongName'])
   matches.append((name_match,overlap,attr))
 note='지면 기준고는 DEM 중앙값 추정; 출입층 미검증'
 if matches:
  attr=max(matches,key=lambda x:(x[0],x[1]))[2]; h=float(attr['heightM']); floors=int(attr['groundFloors']); status='REGISTER'; rid=attr['sourceId']
  if name=='본관':note+='; 본관/북악관 통합 대장 값'
 else:
  h,floors=estimates.get(name,(14,4)); status='ESTIMATE'; rid=''; note+='; 높이와 층수는 러프 추정'
 dense=g.densifyByDistance(2); coords=np.array([[p.x(),p.y()] for p in dense.vertices()]); z=surface(coords)
 c=g.pointOnSurface().asPoint(); z=np.r_[z,surface([[c.x(),c.y()]])]
 assert np.isfinite(z).all()
 base=float(z.min()-1); roof=float(np.median(z)+h)
 if roof<float(z.max()+3):
  roof=float(z.max()+3); note+='; 지형 최고점 위 3m 확보하도록 지붕 상향, 높이 검증 필요'
 if name=='북악관':note+='; DB 보정 층고 3.39m 참고, 9층 가정; 출입층 표고 135.65m는 지상층 번호 불명으로 지붕 기준에 미적용'
 if name in ('혜인관','공연실습소'):note+='; 두 대장 도형 중첩, 수직 관계 미확인'
 g.convertToMultiType()
 attrs=[name,int(f.id()),h,status,rid,floors,round(base,3),round(roof,3),round(roof-base,3),round(float(z.min()),3),round(float(z.max()),3),note]
 out=QgsFeature(model.fields()); out.setGeometry(g); out.setAttributes(attrs); features.append(out); records.append(dict(zip([n for n,t in fields],attrs)))
model.dataProvider().addFeatures(features); model=save(model,'buildings_3d')
model.renderer().setSymbol(QgsFillSymbol.createSimple({'color':'221,220,219,255','outline_color':'173,171,167,255','outline_width':'0.2'}))
symbol=QgsPolygon3DSymbol(); symbol.setAltitudeClamping(Qgis.AltitudeClamping.Absolute)
props=QgsPropertyCollection(); props.setProperty(QgsAbstract3DSymbol.PropertyHeight,QgsProperty.fromField('base_m')); props.setProperty(QgsAbstract3DSymbol.PropertyExtrusionHeight,QgsProperty.fromExpression('roof_m - base_m'))
symbol.setDataDefinedProperties(props)
material=QgsPhongMaterialSettings(); material.setDiffuse(QColor('#dedddb')); material.setAmbient(QColor('#aaa9a5')); material.setShininess(0); symbol.setMaterialSettings(material)
model.setRenderer3D(QgsVectorLayer3DRenderer(symbol))
area.renderer().setSymbol(QgsFillSymbol.createSimple({'color':'243,239,224,255','outline_color':'179,174,148,255','outline_width':'0.35'}))
contours.renderer().setSymbol(QgsLineSymbol.createSimple({'line_color':'123,132,107,100','line_width':'0.13'}))
terrain=QgsRasterLayer(str(dempath),'지형 DEM · 2m 격자')
# Neutral green context; campus boundary supplies the ivory campus surface.
shader=QgsRasterShader(); ramp=QgsColorRampShader(); ramp.setColorRampType(QgsColorRampShader.Interpolated)
ramp.setColorRampItemList([QgsColorRampShader.ColorRampItem(float(Z.min()),QColor('#bfd69c')),QgsColorRampShader.ColorRampItem(float(Z.max()),QColor('#bfd69c'))]); shader.setRasterShaderFunction(ramp)
terrain.setRenderer(QgsSingleBandPseudoColorRenderer(terrain.dataProvider(),1,shader))
for layer in [terrain,area,model,contours,raw]:project.addMapLayer(layer)
project.layerTreeRoot().findLayer(raw.id()).setItemVisibilityChecked(False)
project.layerTreeRoot().findLayer(contours.id()).setItemVisibilityChecked(False)
provider=QgsRasterDemTerrainProvider();provider.setLayer(terrain);project.elevationProperties().setTerrainProvider(provider)
project.viewSettings().setDefaultViewExtent(QgsReferencedRectangle(ext,crs))
settings=Qgs3DMapSettings();settings.setCrs(crs);settings.setTransformContext(project.transformContext());settings.setPathResolver(project.pathResolver());settings.setExtent(ext)
center=area.extent().center(); settings.setOrigin(QgsVector3D(center.x(),center.y(),0)); settings.setLayers([model,area,terrain])
ts=QgsDemTerrainSettings();ts.setLayer(terrain);ts.setResolution(128);ts.setSkirtHeight(10);ts.setVerticalScale(1);settings.setTerrainSettings(ts)
settings.setTerrainShadingEnabled(True);settings.setBackgroundColor(QColor('#f3f3ef'))
light=QgsDirectionalLightSettings(); settings.setLightSources([light]);settings.setMapTileResolution(2048)
ctx=QgsReadWriteContext();ctx.setPathResolver(project.pathResolver());doc=QDomDocument('qgis');root=doc.createElement('qgis');doc.appendChild(root)
views=doc.createElement('mapViewDocks3D');root.appendChild(views);view=doc.createElement('view');views.appendChild(view);view.setAttribute('name','Campus 3D');view.setAttribute('isOpen',1)
view.appendChild(settings.writeXml(doc,ctx))
pose=QgsCameraPose();pose.setCenterPoint(QgsVector3D(0,0,float(surface([[center.x(),center.y()]])[0])));pose.setDistanceFromCenterPoint(620);pose.setPitchAngle(45);pose.setHeadingAngle(0)
camera=doc.createElement('camera')
for key,value in {'xMap':center.x(),'yMap':center.y(),'zMap':float(surface([[center.x(),center.y()]])[0]),'dist':620,'pitch':45,'yaw':0}.items():camera.setAttribute(key,value)
view.appendChild(camera);view.setAttribute('isDocked',0);view.setAttribute('width',1100);view.setAttribute('height',780);project.viewsManager().readXml(root,doc)
assert project.write()
with (OUT/'building_heights.csv').open('w',encoding='utf-8-sig',newline='') as file:
 w=csv.DictWriter(file,fieldnames=records[0].keys());w.writeheader();w.writerows(records)
qa.update({'qgis_version':Qgis.QGIS_VERSION,'buildings':len(records),'height_registered':sum(r['height_source']=='REGISTER' for r in records),'height_estimated':sum(r['height_source']=='ESTIMATE' for r in records),'excluded':skipped,'dem_resolution_m':2,'dem_elevation_range_m':[float(Z.min()),float(Z.max())],'dem_cells':int(Z.size),'dem_nodata_cells':int(np.isnan(Z).sum()),'interpolation':'linear triangulation of densified contours and spot heights','vertical_exaggeration':1})
(OUT/'validation.json').write_text(json.dumps(qa,ensure_ascii=False,indent=2))
(OUT/'view_settings.xml').write_text(doc.toString())
print(json.dumps(qa,ensure_ascii=False,indent=2))
