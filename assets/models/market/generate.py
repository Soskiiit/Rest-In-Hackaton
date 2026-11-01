"""Build original low-poly Chinese market props: two food carts on wheels and two empty stalls.
Python 3 standard library only; no Blender required.

Optimised for the game client: few triangles, vertex colours instead of per-part materials,
and every static part baked into one mesh per animated node and material kind,
so a model costs about ten draw calls."""
from pathlib import Path
import json, math, struct, shutil

OUT = Path(__file__).resolve().parent
CLIENT = OUT.parents[2] / "client" / "public" / "models" / "market"
PI = math.pi
CLIPS = {"Idle": 4, "Roll": 2, "Open": 1.5, "Close": 1.5}
MAX_TRIANGLES = 1000
MAX_DRAW_CALLS = 16

def quat(x=0, y=0, z=0):
    # XYZ intrinsic Euler angles, matching Three.js Euler order XYZ.
    a,b,c,d,e,f = math.cos(x/2),math.sin(x/2),math.cos(y/2),math.sin(y/2),math.cos(z/2),math.sin(z/2)
    return [b*c*e+a*d*f, a*d*e-b*c*f, a*c*f+b*d*e, a*c*e-b*d*f]

def sub(a,b): return [a[i]-b[i] for i in range(3)]
def cross(a,b): return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
def dot(a,b): return sum(a[i]*b[i] for i in range(3))

def rotate(q,v):
    x,y,z,w=q; t=[2*k for k in cross((x,y,z),v)]
    c=cross((x,y,z),t)
    return [v[i]+w*t[i]+c[i] for i in range(3)]

def trs(p,node):
    # Apply a glTF node transform (scale, then rotation, then translation) to point p.
    s=node.get("scale",(1,1,1)); p=[p[i]*s[i] for i in range(3)]
    if "rotation" in node:p=rotate(node["rotation"],p)
    t=node.get("translation",(0,0,0))
    return [p[i]+t[i] for i in range(3)]

def lathe(profile, sides=6, caps=True):
    vertices=[(rx*math.cos(2*PI*i/sides),y,rz*math.sin(2*PI*i/sides))
              for y,rx,rz in profile for i in range(sides)]
    faces=[]
    for j in range(len(profile)-1):
        for i in range(sides):
            a=j*sides+i; b=j*sides+(i+1)%sides; c=a+sides; d=b+sides
            faces += [(a,c,d),(a,d,b)]
    if caps:
        bottom=len(vertices); vertices.append((0,profile[0][0],0))
        top=len(vertices); vertices.append((0,profile[-1][0],0))
        for i in range(sides):
            nxt=(i+1)%sides
            faces += [(bottom,i,nxt),(top,(len(profile)-1)*sides+nxt,(len(profile)-1)*sides+i)]
    return vertices,faces

def sphere(sides, rings):
    return lathe([(-math.cos(PI*j/rings),math.sin(PI*j/rings),math.sin(PI*j/rings))
                  for j in range(rings+1)],sides,False)

def cube():
    v=[(x,y,z) for x in [-1,1] for y in [-1,1] for z in [-1,1]]
    f=[]
    for a,b,c,d in [(0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)]:
        f += [(a,b,c),(a,c,d)]
    return v,f

def torus(tube, n, m):
    # Ring of radius 1 in the XZ plane; the hole is along Y.
    v=[]; f=[]
    for i in range(n):
        u=2*PI*i/n
        for j in range(m):
            t=2*PI*j/m
            v.append(((1+tube*math.cos(t))*math.cos(u),tube*math.sin(t),(1+tube*math.cos(t))*math.sin(u)))
    for i in range(n):
        for j in range(m):
            a=i*m+j; b=((i+1)%n)*m+j; c=((i+1)%n)*m+(j+1)%m; d=i*m+(j+1)%m
            f += [(a,d,c),(a,c,b)]
    return v,f

def panel(sides=8):
    # One umbrella sector centred on +X: apex and two rim corners.
    h=PI/sides
    return [(0,1,0),(math.cos(-h),0,math.sin(-h)),(math.cos(h),0,math.sin(h))],[(0,2,1)]

def roof(ridge=.45, lift=.28):
    """Chinese hip roof with upturned corners: ridge at y=1, eaves at |x|,|z|=1, corners lifted."""
    R1,R2=(-ridge,1,0),(ridge,1,0)
    FL,FM,FR=(-1,lift,1),(0,0,1),(1,lift,1)
    BL,BM,BR=(-1,lift,-1),(0,0,-1),(1,lift,-1)
    LM,RM=(-1,0,0),(1,0,0)
    v=[R1,R2,FL,FM,FR,BL,BM,BR,LM,RM]
    f=[(0,2,3),(0,3,1),(1,3,4),(0,5,6),(0,6,1),(1,6,7),(0,5,8),(0,8,2),(1,4,9),(1,9,7)]
    # Wind every face away from the roof's interior.
    out=[]
    for a,b,c in f:
        n=cross(sub(v[b],v[a]),sub(v[c],v[a]))
        centre=[(v[a][i]+v[b][i]+v[c][i])/3 for i in range(3)]
        out.append((a,b,c) if dot(n,sub(centre,(0,.2,0)))>0 else (a,c,b))
    return v,out

def pennant():
    # Downward triangle of a scalloped valance, in the XY plane.
    return [(-1,0,0),(1,0,0),(0,-1,0)],[(0,2,1)]

SHAPES={
    "box":cube,                                                     # 12 triangles
    "ball":lambda:sphere(6,4),                                      # 36
    "bead":lambda:sphere(5,3),                                      # 20
    "cyl":lambda:lathe([(-1,1,1),(1,1,1)]),                         # 24
    "tire":lambda:torus(.12,8,3),                                   # 48
    "dome":lambda:lathe([(0,1,1),(.6,.7,.7),(1,0,0)],8,False),      # 24
    "panel":panel,                                                  # 1
    "roof":roof,                                                    # 10
    "pennant":pennant,                                              # 1
}
UNIT={name:make() for name,make in SHAPES.items()}

COLORS={
    "steel":(.74,.76,.76), "steel_dark":(.36,.37,.37), "chrome":(.86,.87,.86),
    "rubber":(.035,.035,.04), "black":(.06,.055,.05), "lacquer":(.04,.03,.03),
    "white":(.95,.93,.88), "stone":(.52,.52,.50),
    "red":(.62,.06,.035), "red_dark":(.38,.03,.02), "gold":(.85,.60,.14),
    "wood":(.45,.25,.12), "wood_dark":(.26,.13,.06), "straw":(.82,.68,.38),
    "candy":(.85,.04,.06), "egg":(.98,.95,.86), "herb":(.25,.52,.12), "batter":(.96,.90,.72),
    "bulb":(1.0,.86,.45), "glass":(.78,.90,.92),
    "tile":(.13,.30,.27), "canvas":(.72,.06,.04), "flag_red":(.80,.06,.04), "flag_gold":(.92,.66,.12),
}
# Material kinds: colour comes from COLOR_0, so one material per kind is enough.
KINDS={
    "paint":{"name":"paint","pbrMetallicRoughness":{"baseColorFactor":[1,1,1,1],"metallicFactor":0,"roughnessFactor":.7}},
    "glass":{"name":"glass","pbrMetallicRoughness":{"baseColorFactor":[1,1,1,.28],"metallicFactor":0,"roughnessFactor":.08},
             "alphaMode":"BLEND","doubleSided":True},
    "cloth":{"name":"cloth","pbrMetallicRoughness":{"baseColorFactor":[1,1,1,1],"metallicFactor":0,"roughnessFactor":.75},
             "doubleSided":True},
}
CLOTH={"tile","canvas","flag_red","flag_gold"}  # thin single-layer surfaces seen from both sides
def kind(color): return "glass" if color=="glass" else "cloth" if color in CLOTH else "paint"

class Model:
    def __init__(self, name):
        self.name=name; self.binary=bytearray(); self.parts=[]; self.parent={}; self.slots=0
        self.g={"asset":{"version":"2.0","generator":"Rest-In-Hackaton procedural market 3.0 (low-poly)"},
                "scene":0,"scenes":[{"name":name,"nodes":[0]}],
                "nodes":[],"meshes":[],"materials":[],"bufferViews":[],"accessors":[],"animations":[]}
        self.node(name)
    def accessor(self,data,kind,component=5126,target=None,bounds=False):
        size={"SCALAR":1,"VEC3":3,"VEC4":4}[kind]
        flat=list(data) if size==1 else [v for row in data for v in row]
        while len(self.binary)%4:self.binary.append(0)
        offset=len(self.binary)
        self.binary.extend(struct.pack("<"+("f" if component==5126 else "H")*len(flat),*flat))
        view={"buffer":0,"byteOffset":offset,"byteLength":len(self.binary)-offset}
        if target:view["target"]=target
        vi=len(self.g["bufferViews"]);self.g["bufferViews"].append(view)
        acc={"bufferView":vi,"componentType":component,"count":len(flat)//size,"type":kind}
        if bounds:
            rows=[[x] for x in flat] if size==1 else data
            acc["min"]=[min(row[i] for row in rows) for i in range(size)]
            acc["max"]=[max(row[i] for row in rows) for i in range(size)]
        idx=len(self.g["accessors"]);self.g["accessors"].append(acc);return idx
    def node(self,name,parent=None,pos=None,rot=None):
        n={"name":name}
        if pos is not None:n["translation"]=list(pos)
        if rot is not None:n["rotation"]=list(rot)
        i=len(self.g["nodes"]);self.g["nodes"].append(n)
        if parent is not None:
            self.g["nodes"][parent].setdefault("children",[]).append(i); self.parent[i]=parent
        return i
    def slot(self,group,pos):
        # Empty anchor where a food item's origin (bottom centre) goes; filled later by the client.
        self.node(f"Slot_{group}_{self.slots}",0,pos); self.slots+=1
    def part(self,parent,pos,scale,color,shape="box",rot=None):
        # Parts are not nodes: they are baked into their nearest animated ancestor at save time.
        self.parts.append((parent,{"translation":pos,"rotation":rot or [0,0,0,1],"scale":scale},color,shape))
    def bar(self,parent,a,b,r,color):
        # Square rod between two points (rod axis is local Y).
        d=sub(b,a); length=math.sqrt(sum(k*k for k in d)); d=[k/length for k in d]
        self.part(parent,[(a[i]+b[i])/2 for i in range(3)],(r,length/2,r),color,"box",_axis_y_to(d))
    def animation(self,name,channels):
        anim={"name":name,"samplers":[],"channels":[]}
        for node,path,times,values in channels:
            assert times[0]==0 and times[-1]==CLIPS[name],(name,times)
            inp=self.accessor(times,"SCALAR",bounds=True)
            out=self.accessor(values,"VEC4" if path=="rotation" else "VEC3")
            if path=="rotation":
                assert all(abs(sum(x*x for x in q)-1)<1e-5 for q in values)
            idx=len(anim["samplers"])
            anim["samplers"].append({"input":inp,"output":out,"interpolation":"LINEAR"})
            anim["channels"].append({"sampler":idx,"target":{"node":node,"path":path}})
        self.g["animations"].append(anim)
    def bake(self):
        animated={c["target"]["node"] for a in self.g["animations"] for c in a["channels"]}
        groups={}
        for parent,local,color,shape in self.parts:
            target=parent; chain=[local]
            while target!=0 and target not in animated:
                chain.append(self.g["nodes"][target]); target=self.parent[target]
            groups.setdefault((target,kind(color)),[]).append((chain,color,shape))
        materials={}
        for (target,k),items in groups.items():
            pos=[]; norm=[]; col=[]
            for chain,color,shape in items:
                v,f=UNIT[shape]
                for face in f:
                    tri=[]
                    for i in face:
                        p=list(v[i])
                        for t in chain:p=trs(p,t)
                        tri.append(p)
                    n=cross(sub(tri[1],tri[0]),sub(tri[2],tri[0])); length=math.sqrt(sum(x*x for x in n))
                    if length<1e-12:continue
                    n=[x/length for x in n]
                    pos.extend(tri); norm.extend([n,n,n]); col.extend([COLORS[color]]*3)
            if k not in materials:
                materials[k]=len(self.g["materials"]); self.g["materials"].append(KINDS[k])
            attrs={"POSITION":self.accessor(pos,"VEC3",target=34962,bounds=True),
                   "NORMAL":self.accessor(norm,"VEC3",target=34962),
                   "COLOR_0":self.accessor(col,"VEC3",target=34962)}
            assert len(pos)<65536
            ii=self.accessor(list(range(len(pos))),"SCALAR",5123,34963)
            name=self.g["nodes"][target]["name"]+"_"+k
            mi=len(self.g["meshes"])
            self.g["meshes"].append({"name":name,"primitives":[{"attributes":attrs,"indices":ii,"material":materials[k]}]})
            n=self.node(name,target); self.g["nodes"][n]["mesh"]=mi
    def save(self):
        self.bake()
        self.g["buffers"]=[{"byteLength":len(self.binary)}]
        data=json.dumps(self.g,separators=(",",":"),ensure_ascii=False).encode()
        data+=b" "*((-len(data))%4)
        binary=bytes(self.binary)+b"\0"*((-len(self.binary))%4)
        blob=struct.pack("<III",0x46546c67,2,12+8+len(data)+8+len(binary))
        blob+=struct.pack("<II",len(data),0x4e4f534a)+data
        blob+=struct.pack("<II",len(binary),0x004e4942)+binary
        path=OUT/(self.name+".glb");path.write_bytes(blob)
        triangles=sum(self.g["accessors"][m["primitives"][0]["indices"]]["count"]//3 for m in self.g["meshes"])
        draws=len(self.g["meshes"])
        assert triangles<=MAX_TRIANGLES,(self.name,triangles)
        assert draws<=MAX_DRAW_CALLS,(self.name,draws)
        return {"file":path.name,"bytes":len(blob),"triangles":triangles,"draw_calls":draws,
                "nodes":len(self.g["nodes"]),"slots":self.slots,
                "animations":[a["name"] for a in self.g["animations"]]}

def _axis_y_to(d):
    # Shortest-arc quaternion rotating +Y onto unit vector d.
    x,y,z=d
    if y<-.999999:return [1,0,0,0]
    q=[z,0,-x,1+y]
    n=math.sqrt(sum(k*k for k in q))
    return [k/n for k in q]

FLAT=quat(PI/2)  # torus ring XZ -> XY

def wheel(m,name,parent,pos,r,tire="rubber",spoke="chrome",spokes=2):
    """Wheel in the XY plane, spinning about local Z: tyre and crossed spokes."""
    w=m.node(name,parent,pos)
    m.part(w,(0,0,0),(r,r*(1.6 if tire=="wood" else 1),r),tire,"tire",FLAT)
    for k in range(spokes):
        m.part(w,(0,0,0),(.012 if tire=="wood" else .008,r*.9,.012 if tire=="wood" else .008),spoke,"box",quat(0,0,PI/4+PI*k/spokes))
    return w

def spin(node,rev):
    # One clip of Roll: `rev` turns about Z, keyframes every quarter turn (short-arc safe).
    steps=int(rev*4)
    times=[CLIPS["Roll"]*i/steps for i in range(steps+1)]
    return (node,"rotation",times,[quat(0,0,-PI/2*i) for i in range(steps+1)])

def wobble(node,terms,base=(0,0,0),clip="Idle",cycles=1):
    # terms: [(axis, amplitude, phase)]; whole sine periods, so every clip loops seamlessly.
    T=CLIPS[clip]; n=8*cycles
    times=[T*i/n for i in range(n+1)]
    vals=[]
    for t in times:
        e=list(base)
        for axis,amp,phase in terms:e[axis]+=amp*math.sin(2*PI*cycles*t/T+phase)
        vals.append(quat(*e))
    return (node,"rotation",times,vals)

def ease(t): return t*t*(3-2*t)

def turn(node,start,end,clip="Open"):
    T=CLIPS[clip]; times=[T*i/6 for i in range(7)]
    return (node,"rotation",times,[quat(*[start[k]+(end[k]-start[k])*ease(t/T) for k in range(3)]) for t in times])

def lantern(m,name,parent,pos,size=.07):
    """Red paper lantern with gold caps, pivoting at its hook."""
    hook=m.node(name,parent,pos)
    m.part(hook,(0,-.05,0),(.004,.05,.004),"black")
    m.part(hook,(0,-.11,0),(size*.45,.012,size*.45),"gold")
    m.part(hook,(0,-.11-size,0),(size,size*1.05,size),"red","bead")
    m.part(hook,(0,-.11-2*size-.01,0),(size*.4,.01,size*.4),"gold")
    return hook

def fu_sign(m,parent,pos,size):
    # Diamond "福" plaque: gold border, red diamond, gold centre glyph.
    diamond=quat(0,0,PI/4)
    m.part(parent,pos,(size*1.16,size*1.16,.003),"gold","box",diamond)
    m.part(parent,(pos[0],pos[1],pos[2]+.004),(size,size,.003),"red","box",diamond)
    m.part(parent,(pos[0],pos[1],pos[2]+.008),(size*.42,size*.42,.003),"gold")

def plaque(m,parent,pos,half,glyphs,board="red"):
    # Horizontal shop sign: gold frame, board, gold glyph blocks standing in for characters.
    x,y,z=pos; w,h=half
    m.part(parent,(x,y,z-.008),(w+.025,h+.025,.008),"gold")
    m.part(parent,(x,y,z),(w,h,.01),board)
    step=2*w/(glyphs+1)
    for i in range(glyphs):
        m.part(parent,(x-w+step*(i+1),y,z+.012),(h*.45,h*.55,.003),"gold")

def hip_roof(m,parent,y,half_x,half_z,height,color="tile"):
    m.part(parent,(0,y,0),(half_x,height,half_z),color,"roof")
    ridge=half_x*.45
    m.part(parent,(0,y+height+.015,0),(ridge,.022,.028),"gold")
    for s in [-1,1]:
        m.part(parent,(s*ridge,y+height+.05,0),(.025,.05,.025),"gold","box",quat(0,0,-s*.5))

# ── Carts on wheels ──────────────────────────────────────────────────────────────────────────

def cart_jianbing():
    """Modern jianbing cart: white enamel body, round griddle under glass, red sign, pennant."""
    m=Model("cart_jianbing"); root=0
    R=.28; ax=.38
    wl=wheel(m,"L_Wheel",root,(ax,R,-.37),R)
    wr=wheel(m,"R_Wheel",root,(ax,R,.37),R)
    m.bar(root,(ax,R,-.40),(ax,R,.40),.012,"steel_dark")
    for z in [-.22,.22]:
        m.bar(root,(-.52,0,z),(-.52,.40,z),.016,"steel_dark")
        m.bar(root,(-.62,.76,z),(-.84,.88,z),.014,"chrome")
    m.bar(root,(-.84,.88,-.25),(-.84,.88,.25),.022,"black")
    # Gas cylinder on a rack under the body.
    m.part(root,(-.10,.12,0),(.18,.008,.16),"steel_dark")
    for x in [-.27,.07]:
        m.part(root,(x,.26,0),(.008,.14,.15),"steel_dark")
    m.part(root,(-.10,.24,0),(.10,.11,.10),"red","cyl")
    # Enamel body with a red front panel and four "characters".
    m.part(root,(0,.60,0),(.62,.20,.28),"white")
    m.part(root,(0,.58,.282),(.56,.13,.004),"red")
    for x in [-.36,-.12,.12,.36]:
        m.part(root,(x,.58,.289),(.07,.08,.003),"gold")
    m.part(root,(0,.81,0),(.66,.012,.32),"steel")
    # Work surface: round griddle, batter bucket, eggs and scallions.
    m.part(root,(.16,.84,0),(.25,.02,.25),"black","cyl")
    m.part(root,(.16,.862,0),(.23,.002,.23),"batter","cyl")
    m.part(root,(-.34,.89,-.10),(.07,.07,.07),"white","cyl")
    m.part(root,(-.34,.835,.12),(.09,.012,.07),"steel_dark")
    for x in [-.38,-.30]:
        m.part(root,(x,.86,.12),(.025,.03,.025),"egg","bead")
    m.part(root,(-.48,.84,.0),(.04,.02,.06),"herb")
    # Glass enclosure: fixed sides, top-hinged customer window, red roof.
    for x in [-.64,.64]:
        for z in [-.30,.30]:
            m.part(root,(x,1.06,z),(.012,.24,.012),"chrome")
        m.part(root,(x,1.06,0),(.003,.23,.29),"glass")
    window=m.node("FrontWindow",root,(0,1.30,.30))
    m.part(window,(0,-.235,0),(.62,.23,.003),"glass")
    m.part(window,(0,-.465,0),(.62,.006,.008),"chrome")
    m.part(root,(0,1.31,0),(.66,.012,.32),"red")
    plaque(m,root,(0,1.50,0),(.62,.15),4)
    # Pennant on a pole at the back-left corner.
    m.bar(root,(-.64,1.30,-.30),(-.64,1.98,-.30),.01,"chrome")
    flag=m.node("Flag",root,(-.64,1.92,-.30))
    m.part(flag,(.17,-.07,0),(.17,.07,.003),"flag_red")
    m.part(flag,(.17,-.07,.004),(.05,.04,.002),"flag_gold")
    m.animation("Idle",[wobble(flag,[(1,.35,0),(0,.05,.8)])])
    m.animation("Roll",[spin(wl,1),spin(wr,1),wobble(flag,[(1,.25,0)],base=(0,-.5,0),clip="Roll",cycles=2)])
    m.animation("Open",[turn(window,(0,0,0),(-1.25,0,0))])
    return m.save()

def cart_tanghulu():
    """Traditional red lacquer cart: wooden wheels, pagoda roof, lanterns, tanghulu skewers."""
    m=Model("cart_tanghulu"); root=0
    R=.40
    wl=wheel(m,"L_Wheel",root,(0,R,-.40),R,"wood","wood",3)
    wr=wheel(m,"R_Wheel",root,(0,R,.40),R,"wood","wood",3)
    m.bar(root,(0,R,-.44),(0,R,.44),.02,"wood_dark")
    # Long shafts to the handles at -X, a prop leg at +X.
    for z in [-.24,.24]:
        m.bar(root,(.55,.62,z),(-1.15,.80,z),.022,"wood_dark")
    m.bar(root,(-1.15,.80,-.26),(-1.15,.80,.26),.02,"wood_dark")
    m.bar(root,(.50,0,0),(.50,.46,0),.025,"wood_dark")
    # Red lacquer body with gold bands and a 福 diamond.
    m.part(root,(0,.68,0),(.58,.21,.30),"red")
    for y in [.47,.89]:
        m.part(root,(0,y,0),(.60,.018,.32),"gold")
    fu_sign(m,root,(0,.68,.302),.12)
    m.part(root,(0,.915,0),(.62,.012,.34),"wood_dark")
    # Pagoda roof on four red posts.
    for x in [-.55,.55]:
        for z in [-.28,.28]:
            m.part(root,(x,1.27,z),(.02,.36,.02),"red_dark")
    m.part(root,(0,1.63,.29),(.57,.03,.015),"red_dark")
    hip_roof(m,root,1.64,.80,.50,.30)
    lanterns=[lantern(m,side+"_Lantern",root,(x,1.66,.40)) for side,x in [("L",-.64),("R",.64)]]
    # Tanghulu: a straw bale studded with skewers of candied haws.
    bx,by=-.24,1.12
    m.part(root,(bx,by,0),(.08,.19,.08),"straw","cyl")
    for k in range(6):
        a=2*PI*k/6; d=[math.cos(a)*.75,.66,math.sin(a)*.75]
        n=math.sqrt(dot(d,d)); d=[c/n for c in d]
        start=(bx+d[0]*.06,by+.10,d[2]*.06); end=[start[i]+d[i]*.26 for i in range(3)]
        m.bar(root,start,end,.005,"wood")
        m.part(root,[start[i]+d[i]*.19 for i in range(3)],(.03,.08,.03),"candy","bead",_axis_y_to(d))
    # Syrup pot on a brazier and a hinged candy box.
    m.part(root,(.06,.95,.12),(.08,.025,.08),"black")
    m.part(root,(.06,1.01,.12),(.08,.04,.08),"gold","cyl")
    m.part(root,(.34,.98,0),(.17,.055,.13),"wood")
    m.part(root,(.34,1.02,0),(.15,.01,.11),"candy")
    lid=m.node("CandyLid",root,(.34,1.035,-.13))  # hinge on the back edge
    m.part(lid,(0,.012,.13),(.17,.012,.13),"wood_dark")
    m.part(lid,(0,.012,.13),(.12,.013,.08),"glass")
    L,Rl=lanterns
    m.animation("Idle",[wobble(L,[(2,.09,0),(0,.05,.7)]),wobble(Rl,[(2,.09,1.4),(0,.05,2.2)])])
    m.animation("Roll",[spin(wl,1),spin(wr,1),
                        wobble(L,[(2,.12,0)],base=(0,0,.16),clip="Roll",cycles=2),
                        wobble(Rl,[(2,.12,.9)],base=(0,0,.16),clip="Roll",cycles=2)])
    m.animation("Open",[turn(lid,(0,0,0),(-1.3,0,0))])
    return m.save()

# ── Empty stalls ─────────────────────────────────────────────────────────────────────────────

def stall_pavilion():
    """Traditional wooden stall under a tiled hip roof; empty counter and shelves, shutter awning."""
    m=Model("stall_pavilion"); root=0
    for x in [-.92,.92]:
        for z in [-.55,.55]:
            m.part(root,(x,.04,z),(.08,.04,.08),"stone")
            m.part(root,(x,1.17,z),(.05,1.11,.05),"red")
    for z in [-.58,.58]:
        m.part(root,(0,2.24,z),(.98,.05,.04),"red_dark")
    for x in [-.95,.95]:
        m.part(root,(x,2.24,0),(.04,.05,.58),"red_dark")
    hip_roof(m,root,2.28,1.32,.88,.52)
    plaque(m,root,(0,2.05,.60),(.42,.11),4,"lacquer")
    # Counter at the front (+Z): lacquer panel, gold trim, 福 diamond, dark wood top.
    m.part(root,(0,.48,.44),(.86,.46,.14),"red")
    m.part(root,(0,.88,.585),(.86,.02,.006),"gold")
    fu_sign(m,root,(0,.50,.586),.14)
    m.part(root,(0,.965,.46),(.90,.025,.19),"wood_dark")
    # Back shelving: two sides, back panel and three empty shelves.
    for x in [-.80,.80]:
        m.part(root,(x,.85,-.42),(.02,.85,.13),"wood_dark")
    m.part(root,(0,.85,-.54),(.80,.85,.012),"red_dark")
    for y in [.45,1.20,1.60]:  # bottom shelf is storage behind the counter, the upper two face customers
        m.part(root,(0,y,-.42),(.78,.015,.13),"wood")
    # Shutter board hinged below the sign plaque, raised as an awning; "Close" lowers it onto the counter.
    raised=(-1.4,0,0)
    shutter=m.node("Shutter",root,(0,1.92,.62),quat(*raised))
    m.part(shutter,(0,-.46,0),(.86,.46,.015),"wood")
    for x in [-.86,0,.86]:
        m.part(shutter,(x,-.46,.017),(.02,.46,.006),"wood_dark")
    lanterns=[lantern(m,side+"_Lantern",root,(x,2.19,.66),.09) for side,x in [("L",-1.0),("R",1.0)]]
    for x in [-.6,-.2,.2,.6]:
        m.slot("Counter",(x,.99,.46))
    for y in [1.215,1.615]:
        for x in [-.5,0,.5]:
            m.slot("Shelf",(x,y,-.42))
    L,Rl=lanterns
    m.animation("Idle",[wobble(L,[(2,.08,0),(0,.05,.7)]),wobble(Rl,[(2,.08,1.5),(0,.05,2.3)])])
    m.animation("Close",[turn(shutter,raised,(0,0,0),"Close")])
    return m.save()

def stall_awning():
    """Night-market folding stall: red canvas canopy, pennant valance, light string, empty table."""
    m=Model("stall_awning"); root=0
    # Frame: back poles taller than front, so the canopy sheds rain to the front.
    for x in [-.95,.95]:
        m.bar(root,(x,0,.55),(x,2.10,.55),.018,"steel_dark")
        m.bar(root,(x,0,-.55),(x,2.30,-.55),.018,"steel_dark")
        m.bar(root,(x,2.10,.55),(x,2.30,-.55),.012,"steel_dark")
        m.part(root,(x,.01,.55),(.05,.01,.05),"steel_dark")
        m.part(root,(x,.01,-.55),(.05,.01,.05),"steel_dark")
    tilt=math.atan2(.20,1.10)
    m.part(root,(0,2.215,0),(1.0,.005,.60),"canvas","box",quat(tilt,0,0))
    # Front valance with a sign and gold "characters"; pennants flutter in Idle.
    m.part(root,(0,2.04,.565),(1.0,.08,.005),"canvas")
    for x in [-.45,-.15,.15,.45]:
        m.part(root,(x,2.04,.572),(.06,.055,.003),"gold")
    valance=m.node("Valance",root,(0,1.96,.565))
    for i in range(10):
        x=-.9+i*.2
        m.part(valance,(x,0,0),(.1,.09,1),"flag_gold" if i%2 else "flag_red","pennant")
    # Light string under the front edge.
    lights=m.node("Lights",root,(0,1.86,.45))
    m.part(lights,(0,0,0),(.92,.004,.004),"black")
    for i in range(6):
        x=-.75+i*.3
        m.part(lights,(x,-.04,0),(.025,.035,.025),"bulb","bead")
        m.part(lights,(x,-.015,0),(.008,.015,.008),"black")
    # Folding table with a red cloth hanging at the front and sides.
    for x in [-.78,.78]:
        for z in [-.30,.30]:
            m.bar(root,(x,0,z),(x,.75,z),.012,"steel_dark")
    m.part(root,(0,.765,0),(.88,.015,.38),"white")
    m.part(root,(0,.67,.385),(.90,.11,.006),"red")
    for x in [-.885,.885]:
        m.part(root,(x,.67,0),(.006,.11,.38),"red")
    m.part(root,(0,.67,.393),(.90,.012,.003),"gold")
    for z in [.15,-.15]:
        for x in [-.6,0,.6]:
            m.slot("Table",(x,.78,z))
    m.animation("Idle",[wobble(valance,[(0,.10,0)]),wobble(lights,[(0,.06,1.1)])])
    return m.save()

if __name__=="__main__":
    manifest={"units":"meters","up":"+Y","forward":"+Z (customer side)","origin":"model centre, ground",
              "rig":"rigid node hierarchy; no skinning","colors":"vertex COLOR_0, materials: paint / glass / cloth",
              "slots":"empty nodes Slot_<group>_<n>: bottom centre of an item placed on that surface",
              "clips":CLIPS,
              "models":[cart_jianbing(),cart_tanghulu(),stall_pavilion(),stall_awning()]}
    (OUT/"manifest.json").write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+"\n")
    CLIENT.mkdir(parents=True,exist_ok=True)
    for model in manifest["models"]:
        shutil.copyfile(OUT/model["file"],CLIENT/model["file"])
    print(json.dumps([{k:v for k,v in x.items() if k!="animations"} for x in manifest["models"]],ensure_ascii=False))
