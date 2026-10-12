"""Z13: 바위 정원 옆 계단 띠의 폭 — 잰 값과 후보 평면도(같은 축척, 북쪽이 위). 모델은 고치지 않는다. 그림은 볼트에만 쓴다.   python -X utf8 candidates.py
잰 것:
  1) 차도 동쪽 턱 선: S-MAP 0.5 m 메시를 동서로 잘라 차도 가운데 높이보다 0.15 m 솟는 첫 칸(z03/smap-mesh-z03-plaza-05m). 나무 밑은 메시가 솟아 바깥 선에는 쓰지 않는다.
  2) 띠의 폭: 네이버 전방위 사진(08~10 과 사이 지점)의 오른쪽 면 한가운데(차 옆)에서 바깥 벽 발치까지의 내림각 → 거리(카메라 높이 2.45 m, 참 높이 보정) − 카메라~턱 2.6 m.
후보: 지금 / 가 = 지금 턱 선 + 한결같은 폭 / 나 = 지금 턱 선 + 잰 폭 / 다 = 턱 선(차도 가운데 선)을 메시대로 옮기고 잰 폭"""
import json, pathlib, sys
import numpy as np
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
plt.rcParams['font.family'] = 'Malgun Gothic'; plt.rcParams['axes.unicode_minus'] = False
HERE = pathlib.Path(__file__).parent; sys.path.insert(0, str(HERE.parent / 'z03'))
from common import Mesh
OUT = pathlib.Path(r'C:\campus-tracker-backend\데이터\보완자료\3d-map-audit-20261009\z13'); OUT.mkdir(exist_ok=True)
X0, Y0 = 201000.0, 557000.0
V2 = next(np.array(f['geometry']['coordinates']) for f in json.loads((HERE.parent / 'v02' / 'road-profile.geojson').read_text(encoding='utf-8'))['features'] if f['properties'].get('id') == 'V2')
RE = [(180, 102.0), (184, 100.0), (188, 98.0), (192, 96.5), (196, 95.5), (200, 94.5), (204, 94.5), (208, 95.5), (212, 94.0), (216, 94.5), (220, 94.0), (224, 94.0), (228, 94.0), (232, 95.0), (236, 95.5), (240, 95.0), (244, 96.0), (248, 97.0), (252, 98.0)]   # z03/build_inputs.py 의 RE
def cx(y): return float(np.interp(Y0 + y, V2[:, 1], V2[:, 0])) - X0                 # 지금 차도 가운데 선(사용자 핀·V02)
def kerb_now(y): return cx(y) + 3.8                                                 # 지금 계단 띠의 안쪽 선(z03 KERB_OFF)
def out_now(y): return float(np.interp(max(y, 212.0), [a for a, _ in RE], [b for _, b in RE])) + 3.5   # 지금 바깥 선(S-MAP 정사)
Y_FOOT, Y_TOP = 203.5, 252.0

# 1) 메시의 턱 선
M = Mesh(); xs = np.arange(X0 + 78, X0 + 104.01, 0.25); mesh = []
for y in np.arange(202.0, 254.1, 1.5):
    z = M.at(xs, np.full_like(xs, Y0 + y)); i0 = int(np.argmin(np.abs(xs - X0 - cx(y)))); zc = np.nanmedian(z[i0 - 6:i0 + 7])
    e = next((xs[i] - X0 for i in range(i0, len(xs)) if z[i] - zc > 0.15), np.nan); w = next((xs[i] - X0 for i in range(i0, 0, -1) if z[i] - zc > 0.12), np.nan); mesh.append((y, w, e))
mesh = np.array(mesh); ok = ~np.isnan(mesh[:, 2]); a, b = np.polyfit(mesh[ok, 0], mesh[ok, 2], 1); res = float(np.std(mesh[ok, 2] - (a * mesh[ok, 0] + b)))
def kerb_mesh(y): return a * y + b
# 2) 사진에서 잰 폭: (북좌표, 좁은 곳(둥근 화단 코), 넓은 곳(긴 의자 자리·벽 발치), 무엇)
MEAS = [(213.1, 1.8, 4.4, '10: 둥근 화단 코 / 긴 의자 뒤 벽'), (224.1, 2.4, 4.7, '09-10 사이: 둥근 화단 코 / 긴 의자 뒤 벽'), (235.1, None, 3.1, '09: 못 가장자리의 낮은 굽은 벽'), (246.1, None, 4.3, '08-09 사이: 바위 발치(긴 의자 뒤)'), (256.5, None, 2.1, '08: 곧은 화단 벽')]
ERR = 0.8
WY = [Y_FOOT] + [m[0] for m in MEAS]; WW = [3.0] + [m[2] for m in MEAS]      # 첫 단 자리는 아래 인도 폭(3.0 m)에 이음
def w_meas(y): return float(np.interp(y, WY, WW))
W_CONST = float(np.mean([m[2] for m in MEAS] + [m[1] for m in MEAS if m[1]]))  # 좁은 곳·넓은 곳 일곱 값의 평균
CANDS = [('지금 모델', kerb_now, out_now, '#b9b4a8'), (f'가: 지금 턱 선 + 한결같은 폭 {W_CONST:.1f} m', kerb_now, lambda y: kerb_now(y) + W_CONST, '#e6c36a'),
         ('나: 지금 턱 선 + 잰 폭', kerb_now, lambda y: kerb_now(y) + w_meas(y), '#8fc08a'), ('다: 턱 선을 메시대로 옮기고 + 잰 폭', kerb_mesh, lambda y: kerb_mesh(y) + w_meas(y), '#7fb0e0')]
CAM = [(202.1, 90.7), (213.1, 90.7), (224.1, 91.3), (235.1, 91.7), (246.1, 91.5)]   # 전방위 사진 자리(네이버 자료의 경위도)
def score(kerb, out):
    """관찰마다 (맞음 ○ / 반쯤 △ / 어긋남 ×, 값)."""
    rows = []
    for y, lo, hi, what in MEAS:
        yy = min(y, Y_TOP); w = out(yy) - kerb(yy); hi = hi if y <= Y_TOP else w_meas(Y_TOP); d = w - hi; ok_ = abs(d) <= ERR or (lo is not None and lo - ERR <= w <= hi + ERR)   # 띠는 252 에서 끝난다: 그 위 사진(256)은 246 과의 사이 값으로 견줌
        rows.append((f'폭 {yy:.0f}: 잰 값 {("%.1f~" % lo) if lo else ""}{hi:.1f} m' + ('' if y <= Y_TOP else '(246·256 사이)'), '○' if abs(d) <= ERR else ('△' if ok_ else '×'), f'{w:.1f} m'))
    ws = [out(y) - kerb(y) for y in (Y_FOOT, 228.0, Y_TOP)]
    rows.append(('위로 갈수록 넓어지지 않음', '○' if ws[2] - ws[0] < 1.5 else '×', f'{ws[0]:.1f} → {ws[2]:.1f} m'))
    dk = [kerb(y) - kerb_mesh(y) for y in (205.0, 220.0, 235.0, 250.0)]
    rows.append((f'턱 선 = 메시 턱 선(±{res:.1f} m)', '○' if max(abs(v) for v in dk) <= 2 * res else '×', '차 ' + ' / '.join(f'{v:+.1f}' for v in dk) + ' m'))
    off = [x - (kerb(y) - 3.5) for y, x in CAM]
    rows.append(('사진 찍은 차 ~ 가운데 선이 한결같음', '○' if max(off) - min(off) <= 1.5 else '×', f'{min(off):+.1f} ~ {max(off):+.1f} m'))
    do = [out(y) - out_now(y) for y in (213.0, 235.0, 250.0)]
    rows.append(('바깥 선 = S-MAP 정사의 밝은 띠 끝', '○' if max(abs(v) for v in do) <= 1.0 else '×', '차 ' + ' / '.join(f'{v:+.1f}' for v in do) + ' m'))
    rows.append(('차도 가운데 선(V02)을 그대로 둠', '○' if kerb is kerb_now else '×', '그대로' if kerb is kerb_now else f'{kerb_mesh(205) - kerb_now(205):+.1f} ~ {kerb_mesh(250) - kerb_now(250):+.1f} m 옮김'))
    return rows

ys = np.arange(Y_FOOT, Y_TOP + 0.01, 0.5); yr = np.arange(196.0, 258.01, 0.5)
fig = plt.figure(figsize=(21, 13.5)); gs = fig.add_gridspec(2, 4, height_ratios=[3.4, 1.25], hspace=0.08, wspace=0.12)
for k, (name, kerb, out, col) in enumerate(CANDS):
    ax = fig.add_subplot(gs[0, k]); shift = (lambda y: kerb(y) - kerb_now(y)) if kerb is not kerb_now else (lambda y: 0.0)
    cxa = np.array([cx(y) + (shift(y) if Y_FOOT <= y <= Y_TOP else shift(min(max(y, Y_FOOT), Y_TOP))) for y in yr])
    ax.fill_betweenx(yr, cxa - 3.5, cxa + 3.5, color='#2b2d30', alpha=.85, lw=0)                                  # 차도(턱에서 턱)
    ax.fill_betweenx(yr, cxa - 5.0, cxa - 3.5, color='#b0a79d', lw=0)                                             # 서쪽 인도
    ax.fill_betweenx(ys, [kerb(y) for y in ys], [out(y) for y in ys], color=col, ec='k', lw=.8)                   # 계단 띠
    ax.plot([out_now(y) for y in ys], ys, 'k--', lw=.9, label='지금 바깥 선(S-MAP 정사)')
    ax.plot([cx(y) for y in yr], yr, color='#ffd24a', lw=.9, ls=':', label='지금 차도 가운데 선(사용자 핀·V02)')
    ax.plot(mesh[:, 2], mesh[:, 0], 'c.', ms=6, label='메시의 동쪽 턱(+0.15 m)'); ax.plot(mesh[:, 1], mesh[:, 0], '.', color='#3aa0a0', ms=4, label='메시의 서쪽 솟는 곳(+0.12 m)')
    for y, lo, hi, what in MEAS:
        yy = min(y, Y_TOP + 4.5); kx = kerb(min(y, Y_TOP)); ax.errorbar([kx + hi], [yy], xerr=ERR, fmt='rs', ms=5, capsize=3, lw=1.2, label='사진: 넓은 곳의 벽 발치(이 턱 선에서 잰 폭, ±0.8 m)' if y < 214 else None)
        if lo: ax.plot([kx + lo], [yy], 'r^', ms=6, label='사진: 둥근 화단 코' if y < 214 else None)
        ax.plot([kx, kx + hi], [yy, yy], 'r-', lw=.6); ax.text(101.6, yy, f'{y:.0f}', fontsize=7, color='r', va='center')
    for y, x in CAM: ax.plot([x], [y], 'x', color='#ff8c00', ms=7, mew=1.6, label='전방위 사진 자리(네이버)' if y < 203 else None)
    for y in (Y_FOOT, 215.0, 228.0, 240.0, Y_TOP): ax.text(kerb(y) + 0.15, y + 0.3, f'{out(y) - kerb(y):.1f} m', fontsize=9, weight='bold')
    ax.set_xlim(78, 104); ax.set_ylim(196, 262); ax.set_aspect('equal'); ax.grid(lw=.3); ax.tick_params(labelsize=7); ax.set_title(name, fontsize=12)
    ax.set_xlabel('동좌표 - 201000 (m)', fontsize=8)
    if k == 0: ax.set_ylabel('북좌표 - 557000 (m)   ↑ 북', fontsize=8); ax.legend(fontsize=6.5, loc='upper left')
    ax.annotate('북', xy=(102.5, 260.5), xytext=(102.5, 256.5), ha='center', fontsize=9, arrowprops=dict(arrowstyle='->'))
    t = fig.add_subplot(gs[1, k]); t.axis('off'); rows = score(kerb, out)
    tb = t.table(cellText=[[r[0], r[1], r[2]] for r in rows], colLabels=['관찰', '', '이 후보의 값'], colWidths=[0.58, 0.06, 0.36], loc='upper center', cellLoc='left'); tb.auto_set_font_size(False); tb.set_fontsize(7.6); tb.scale(1, 1.25)
    for (r, c), cell in tb.get_celld().items():
        if r > 0 and c == 1: cell.set_text_props(color={'○': 'green', '△': '#b8860b', '×': 'red'}[rows[r - 1][1]], weight='bold', ha='center')
    n = [sum(r[1] == s for r in rows) for s in '○△×']; t.text(0.5, -0.02, f'맞음 {n[0]} · 반쯤 {n[1]} · 어긋남 {n[2]}', ha='center', fontsize=10, weight='bold', transform=t.transAxes)
    print(name, n, [(r[0], r[1], r[2]) for r in rows])
fig.suptitle('Z13 바위 정원 옆 계단 띠의 폭 후보 (같은 축척, 북쪽이 위. 모델은 고치지 않음). 검은 띠 = 차도, 색 띠 = 계단 띠, 굵은 수 = 그 자리의 띠 폭', fontsize=13, y=0.93)
fig.savefig(OUT / '후보-z13-계단띠-폭.png', dpi=110, bbox_inches='tight')
print('mesh kerb line: x = %.4f*y + %.2f, residual %.2f; at 205/228/250: %.1f %.1f %.1f; now: %.1f %.1f %.1f; W_CONST %.2f' % (a, b, res, kerb_mesh(205), kerb_mesh(228), kerb_mesh(250), kerb_now(205), kerb_now(228), kerb_now(250), W_CONST))
print('mesh carriageway width 211~244:', np.round(np.nanmedian((mesh[:, 2] - mesh[:, 1])[(mesh[:, 0] >= 211) & (mesh[:, 0] <= 244)]), 1))
