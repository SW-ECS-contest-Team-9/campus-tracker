#!/bin/sh
# T06: 시험용 DB 의 길·노드를 JSON 으로 뽑는다(읽기만). 사용법: sh dump_state.sh <출력 폴더> <접두사>
P="docker exec campus-tracker-test-db psql -U campus -d campus -At -c"
$P "select json_agg(json_build_object('id',id,'name',name,'cls',road_class,'structure',structure,'w',width_m,'bld',building_id,'lvl',level_id,'rev',revision,'status',status,'from',from_node_id,'to',to_node_id,'c',st_asgeojson(geom,3)::json->'coordinates')) from mobility.road_segments where status in ('DRAFT','APPROVED')" > "$1/$2-roads.json"
$P "select json_agg(json_build_object('id',id,'c',st_asgeojson(geom,3)::json->'coordinates')) from mobility.network_nodes" > "$1/$2-nodes.json"
