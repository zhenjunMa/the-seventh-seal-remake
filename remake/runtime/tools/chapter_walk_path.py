"""Read-only grid path aid for manual browser verification; does not move a player."""
from pathlib import Path
import heapq
import json
import sys

web = Path(__file__).resolve().parents[1]/'web'
map_id = sys.argv[1].lower()
start = tuple(int(float(value)//16) for value in sys.argv[2:4])
end = tuple(map(int, sys.argv[4:6]))
data = json.loads((web/f'data/maps/{map_id}.json').read_text(encoding='utf-8'))
m = data['movement']
blocks = {(t['x'],t['y']) for t in m['triggers']}
blocks.discard(start)
blocks.discard(end)
initial=(*start,None)
q = [(0,0,initial)]; prev = {initial:None}; costs={initial:0}; reached = None; serial=0
while q:
    cost,_,state=heapq.heappop(q)
    if costs[state]!=cost: continue
    p=state[:2]
    if p == end: reached = state; break
    for direction,(dx,dy) in enumerate([(0,1),(1,0),(0,-1),(-1,0)]):
        n = (p[0]+dx,p[1]+dy)
        nxt=(*n,direction); candidate=cost+1+(8 if state[2] is not None and state[2]!=direction else 0)
        if (0 <= n[0] < m['width'] and 0 <= n[1] < m['height']
            and m['terrain_rows'][n[1]][n[0]] == '0' and n not in blocks and candidate<costs.get(nxt,float('inf'))):
            prev[nxt]=state; costs[nxt]=candidate; serial+=1; heapq.heappush(q,(candidate,serial,nxt))
if reached is None: raise SystemExit('No path')
path=[]
while reached != initial:
    old=prev[reached]; path.append((reached[0]-old[0],reached[1]-old[1])); reached=old
path.reverse(); groups=[]
names={(0,1):'Down',(1,0):'Right',(0,-1):'Up',(-1,0):'Left'}
for step in path:
    if groups and groups[-1][0] == names[step]: groups[-1][1]+=1
    else: groups.append([names[step],1])
print(json.dumps({'start_cell':start,'end_cell':end,'keys_cells':groups},ensure_ascii=False))
