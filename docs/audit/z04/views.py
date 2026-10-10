"""Z04: 비교 그림의 시점(근거 그림마다 카메라 자리·보는 점·가로 시야각). S-MAP 화면은 2차·V02 에서 복원한 카메라(자리·방위·내려다보는 각)를 쓰고, 사진·거리뷰는 눈대중이다.
  python views.py -> views.json, 콘솔에 넣을 한 줄"""
import json, pathlib, math
def cam(x, y, z, heading, pitch, ground):   # 방위(북에서 시계 방향)와 내려다보는 각으로 보는 점을 구한다
    d = (z - ground) / math.tan(math.radians(pitch)); return [round(x + d * math.sin(math.radians(heading)), 1), round(y + d * math.cos(math.radians(heading)), 1), ground]
U1, U2, U3, U4 = '사용자-출입구·주차장-20261010/', '사용자-서문·제2주차장·수인관-20261010/', '사용자-SMAP높이-20261010/', '사용자-서문-공연실습소-생활관-20261010/'
V = {
 '01-회차공간-SMAP-SM07': dict(pos=[201134.4, 557303.7, 340.0], tgt=cam(201134.4, 557303.7, 340, 282.6, 57.1, 130), fov=43.5, evidence='smap-user-main-west-detail.png', zone='turnaround', cam='복원(2차)'),
 '02-회차공간-위성-그림11': dict(pos=[201035.0, 557350.0, 480.0], tgt=[201035.0, 557350.0, 130.0], fov=30, evidence=U2 + '11-네이버위성-회차공간·오르막길-포장면-사용자표시.webp', zone='turnaround', cam='위에서(틀은 눈대중)'),
 '03-오르막입구-거리뷰09': dict(pos=[201034.0, 557356.0, 132.6], tgt=[201060.0, 557345.5, 135.0], fov=92, evidence=U2 + '09-오르막보행로-입구-차단기-거리뷰-202502.webp', zone='turnaround(G02 아래 끝)', cam='눈대중(G02 시점 1)'),
 '04-북악관정문-거리뷰10': dict(pos=[201032.0, 557350.0, 132.4], tgt=[201044.0, 557367.0, 134.5], fov=80, evidence=U2 + '10-북악관-정문계단-거리뷰-202502.webp', zone='turnaround(G02 정문 계단)', cam='눈대중'),
 '05-한림관가는길-SMAP-그림13': dict(pos=[201147.1, 557264.2, 285.2], tgt=cam(201147.1, 557264.2, 285.2, 315.4, 78.3, 126), fov=43.7, evidence=U1 + '13-SMAP-한림관-가는길-높이표시.webp', zone='upper-branch', cam='복원(V02)'),
 '06-본관양쪽-SMAP-SM09': dict(pos=[201124.3, 557324.2, 288.0], tgt=cam(201124.3, 557324.2, 288, 221.4, 70.9, 128), fov=41.1, evidence='smap-user-main-building-both-sides.png', zone='upper-branch·yudam9', cam='복원(2차)'),
 '07-한림관1층-거리뷰05': dict(pos=[201086.0, 557268.0, 123.2], tgt=[201112.0, 557274.0, 128.0], fov=95, evidence=U1 + '05-한림관1층-가는길-네이버거리뷰-202506.webp', zone='upper-branch', cam='눈대중'),
 '08-뒤에서-SMAP-그림13': dict(pos=[201205.0, 557430.0, 240.0], tgt=[201190.0, 557318.0, 152.0], fov=50, evidence=U2 + '13-SMAP-뒤에서-청운·상승·대일관뒷문-사용자표시.webp', zone='back-paths', cam='눈대중'),
 '09-북악관옆길-거리뷰GS25': dict(pos=[201001.0, 557372.0, 132.6], tgt=[201008.0, 557395.0, 133.0], fov=85, evidence='streetview-bukak-gs25-202502-02.png', zone='back-paths', cam='눈대중'),
 '10-청운관-사진23': dict(pos=[201193.0, 557262.0, 151.0], tgt=[201220.0, 557282.0, 157.0], fov=62, evidence=U3 + '사진-23-청운관-열린돌출부.png', zone='cheongun', cam='눈대중'),
 '11-혜인관-사진01': dict(pos=[201203.0, 557224.0, 150.6], tgt=[201220.0, 557212.0, 151.5], fov=75, evidence=U1 + '01-혜인관-운동장쪽-1층과B1.jpg', zone='hyein', cam='눈대중'),
 '12-은주관코트-SMAP-SM11': dict(pos=[201078.4, 557187.3, 386.0], tgt=cam(201078.4, 557187.3, 386, 127.0, 76.8, 135), fov=43.9, evidence='smap-user-eunju-court-pins.png', zone='eunju·hyein', cam='복원(2차)'),
 '13-은주관-운동장에서': dict(pos=[201188.0, 557238.0, 150.6], tgt=[201160.0, 557190.0, 154.0], fov=72, evidence='사용자-공연실습소-은주관-20261010/은주관-운동장에서.png', zone='eunju', cam='눈대중'),
 '14-유담관9층-거리뷰M06': dict(pos=[201036.0, 557298.0, 128.6], tgt=[201022.0, 557330.0, 130.5], fov=95, evidence='streetview-main-p1-202602-06.png', zone='yudam9', cam='눈대중'),
 '15-서문-사진': dict(pos=[200958.0, 557401.0, 118.6], tgt=[200984.0, 557399.5, 121.0], fov=78, evidence=U4 + '서문.jpg', zone='west', cam='눈대중'),
 '16-정문·코트-SMAP-SM15': dict(pos=[200991.7, 557138.3, 374.0], tgt=cam(200991.7, 557138.3, 374, 102.6, 72.0, 110), fov=44.8, evidence='smap-court-parallel-roads.png', zone='gate·eunju', cam='복원(2차)'),
 '17-정문-거리뷰': dict(pos=[201142.0, 557080.0, 108.3], tgt=[201128.0, 557116.0, 110.0], fov=92, evidence='streetview-seogyeongro-202512.png', zone='gate', cam='눈대중'),
 '18-제1주차장-사진02': dict(pos=[201120.0, 557130.0, 108.9], tgt=[201097.0, 557158.0, 110.5], fov=78, evidence=U1 + '02-제1주차장-정문옆.jpg', zone='gate', cam='눈대중'),
 '19-전체-남서에서': dict(pos=[200930.0, 557060.0, 330.0], tgt=[201110.0, 557270.0, 125.0], fov=50, evidence='f06/08-후-남서쪽에서-비스듬히-전체.png', zone='전체(전: F06 뒤의 시험 지도)', cam='F06 과 같은 시점(눈대중)'),
}
(pathlib.Path(__file__).parent / 'views.json').write_text(json.dumps(V, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({k: {a: b for a, b in v.items() if a in ('pos', 'tgt', 'fov')} for k, v in V.items()}, ensure_ascii=False))
