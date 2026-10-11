"""P02: 새로 잡은 시점(나머지는 p01/views.json).   python make_views.py  -> views.json"""
import json, pathlib
V = {}
def v(name, pos, tgt, fov, cam): V[name] = {'pos': list(pos), 'tgt': list(tgt), 'fov': fov, 'cam': cam}
v('q19-운동장-위에서', (201100.1, 557217.5, 183.7), (201172.4, 557249.3, 150.0), 84, '사진 19: 청운관 지붕 모서리 둘·혜인관 벽 발치 양 끝·은주관 탑으로 맞춘 시점(잔차 3 화소). 은주1관 서쪽 18 m, 높이 184 m 의 넓은 각')
pathlib.Path(__file__).with_name('views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(V))
