# Z05 write_out.py 가 같은 이름 공간에서 실행한다: 기단 위에 얹는 상자. Z04 의 상자(z04/boxes.py)를 그대로 쓰되 본관·한림관 사이 계단(추정이었고 사용자가 없다고 함)은 뺀다. 그 뒤에 Z05 상자.
import re
_src = (HERE / 'boxes.py').read_text(encoding='utf-8')
_src = re.sub(r"stairs\('upper-branch', 'Z04-HANLIM-WGAP-STAIR'.*?basePlane='Z04-UPPER-HANLIM-WGAP'\)\n", '', _src, flags=re.S); assert 'WGAP-STAIR' not in _src
_src = _src.replace('WG = np.array([200984.0, 557399.5])', 'WG = np.array([wx(557399.5) - 1.3, 557399.5])'); assert 'wx(557399.5)' in _src   # 서문 문틀을 옹벽 면(wx)에 붙인다
exec(_src.replace('Z04-', 'Z05-').replace('Z04 ', 'Z05 '))
if (HERE5 / 'boxes_z05.py').exists(): exec((HERE5 / 'boxes_z05.py').read_text(encoding='utf-8'))
