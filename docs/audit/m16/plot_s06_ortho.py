"""복원 카메라와 역투영 기준점을 이용한 정사영상 표본 대응 도표(추정)."""
import hashlib
import json
import sys
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

audit=Path(sys.argv[1])
cam_path=audit/'claude-m17/ortho-camera-recovery.json'
cam=json.loads(cam_path.read_text(encoding='utf-8'))
refs=cam['unprojected_read_points']
eye=np.array(cam['camera']['eye'])
# 같은 원화면의 crop→screenshot 변환은 analyze_panels.py에 기록된 값.
xyz=np.array([p['xyz'] for p in refs])
pixel=np.array([[120+p['crop'][0]/2.5,130+p['crop'][1]/2.5] for p in refs])
normalized=(xyz[:,:2]-eye[:2])/(eye[2]-xyz[:,2,None])
design=np.c_[normalized,np.ones(len(refs))]
fit=np.linalg.lstsq(design,pixel,rcond=None)[0]
residual=np.linalg.norm(design@fit-pixel,axis=1)
paths=[audit/'claude-m16'/n for n in ('s06-cross-sections-raw-20261010.json','s06-outer-cross-sections-raw-20261010.json')]
extended = len(sys.argv) > 2 and sys.argv[2] == '--extended'
if extended:
    paths = [audit/'claude-m16/s06-extended-samples.json']
samples=sum([json.loads(p.read_text(encoding='utf-8'))['points'] for p in paths],[])
coords=np.array([[p['x'],p['y'],json.loads(p['raw'])['result']['dem_z']] for p in samples])
uv=np.c_[(coords[:,:2]-eye[:2])/(eye[2]-coords[:,2,None]),np.ones(len(coords))]@fit
image_path=audit/'claude-m16/S06/smap-ortho-yudam-main-road-c201060_557270-r600.jpg'
fig,ax=plt.subplots(figsize=(12,7))
ax.imshow(plt.imread(image_path))
for station in sorted({p['station'] for p in samples}):
    indices=sorted([i for i,p in enumerate(samples) if p['station']==station],key=lambda i:samples[i]['offsetM'])
    ax.plot(uv[indices,0],uv[indices,1],'-o',color='cyan',linewidth=1,markersize=3)
    i=next(i for i in indices if samples[i]['offsetM']==0)
    ax.annotate(f'R{station}',uv[i],xytext=(6,-12),textcoords='offset points',color='white',backgroundcolor='black')
ax.set_title('S06 extended +/-1 m sample projection estimate, NOT road boundaries' if extended else 'S06 sample projection estimate: +/-3 m probes, NOT road boundaries')
ax.set_xlim(0,800);ax.set_ylim(450,0)
ax.set_xlabel('Original screenshot pixel x');ax.set_ylabel('Original screenshot pixel y')
fig.tight_layout()
stem = 's06-extended-projection-estimate' if extended else 's06-ortho-projection-estimate'
fig.savefig(audit/'claude-m16'/f'{stem}.png',dpi=160)
result={'method':'Height-aware perspective fit to 12 recovered roof references. Ground projection extrapolation, not independent ground validation.',
        'referenceResidualRmsPx':float(np.sqrt(np.mean(residual**2))),
        'referenceResidualMaxPx':float(max(residual)), 'fit':fit.tolist(),
        'inputs':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [cam_path,image_path]+paths},
        'samples':[dict(station=p['station'],offsetM=p['offsetM'],pixel=q.tolist()) for p,q in zip(samples,uv)],
        'accuracyVerified':False}
(audit/'claude-m16'/f'{stem}.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print('Roof reference RMS/max pixels:',result['referenceResidualRmsPx'],result['referenceResidualMaxPx'])
