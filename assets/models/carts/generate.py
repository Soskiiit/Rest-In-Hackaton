"""Build original low-poly street-food carts. Python 3 standard library only; no Blender required.

Optimised for the game client: few triangles, vertex colours instead of per-part materials,
and every static part baked into one mesh per animated node and material kind,
so a cart costs about ten draw calls."""
from pathlib import Path
import json, math, struct, shutil

OUT = Path(__file__).resolve().parent
CLIENT = OUT.parents[2] / "client" / "public" / "models" / "carts"
PI = math.pi
CLIPS = {"Idle": 4, "Roll": 2, "Open": 1.5}
MAX_TRIANGLES = 1000
MAX_DRAW_CALLS = 16

def quat(x=0, y=0, z=0):
    # XYZ intrinsic Euler angles, matching Three.js Euler order XYZ.
    a,b,c,d,e,f = math.cos(x/2),math.sin(x/2),math.cos(y/2),math.sin(y/2),math.cos(z/2),math.sin(z/2)
    return [b*c*e+a*d*f, a*d*e-b*c*f, a*c*f+b*d*e, a*c*e-b*d*f]

def sub(a,b): return [a[i]-b[i] for i in range(3)]
def cross(a,b): return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]

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

SHAPES={
    "box":cube,                                                     # 12 triangles
    "ball":lambda:sphere(6,4),                                      # 36
    "bead":lambda:sphere(5,3),                                      # 20
    "cyl":lambda:lathe([(-1,1,1),(1,1,1)]),                         # 24
    "tire":lambda:torus(.12,8,3),                                   # 48
    "pot":lambda:lathe([(-1,.9,.9),(-.8,1,1),(1,1,1)],8),           # 48
    "dome":lambda:lathe([(0,1,1),(.6,.7,.7),(1,0,0)],8,False),      # 24
    "panel":panel,                                                  # 1
}
UNIT={name:make() for name,make in SHAPES.items()}

COLORS={
    "steel":(.74,.76,.76), "steel_dark":(.36,.37,.37), "chrome":(.86,.87,.86),
    "rubber":(.035,.035,.04), "black":(.06,.055,.05),
    "teal":(.04,.33,.36), "teal_dark":(.02,.19,.21),
    "red":(.60,.05,.035), "yellow":(.93,.68,.10), "gold":(.73,.48,.13),
    "bread":(.80,.47,.16), "herb":(.20,.47,.10), "carrot":(.93,.42,.07), "ham":(.86,.48,.45),
    "ember":(1.0,.30,.04), "blue":(.07,.22,.55), "white":(.95,.93,.88), "noodle":(.95,.80,.36),
    "egg":(.98,.95,.86), "lime":(.38,.66,.13), "gas":(.72,.07,.05), "broth":(.45,.20,.05),
    "glass":(.78,.90,.92), "canopy_red":(.78,.07,.05), "canopy_white":(.96,.94,.88),
}
# Material kinds: colour comes from COLOR_0, so one material per kind is enough.
KINDS={
    "paint":{"name":"paint","pbrMetallicRoughness":{"baseColorFactor":[1,1,1,1],"metallicFactor":0,"roughnessFactor":.7}},
    "glass":{"name":"glass","pbrMetallicRoughness":{"baseColorFactor":[1,1,1,.28],"metallicFactor":0,"roughnessFactor":.08},
             "alphaMode":"BLEND","doubleSided":True},
    "cloth":{"name":"cloth","pbrMetallicRoughness":{"baseColorFactor":[1,1,1,1],"metallicFactor":0,"roughnessFactor":.75},
             "doubleSided":True},
}
def kind(color): return "glass" if color=="glass" else "cloth" if color.startswith("canopy") else "paint"

class Model:
    def __init__(self, name):
        self.name=name; self.binary=bytearray(); self.parts=[]; self.parent={}
        self.g={"asset":{"version":"2.0","generator":"Rest-In-Hackaton procedural carts 2.0 (low-poly)"},
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
                "nodes":len(self.g["nodes"]),"animations":[a["name"] for a in self.g["animations"]]}

def _axis_y_to(d):
    # Shortest-arc quaternion rotating +Y onto unit vector d.
    x,y,z=d
    if y<-.999999:return [1,0,0,0]
    q=[z,0,-x,1+y]
    n=math.sqrt(sum(k*k for k in q))
    return [k/n for k in q]

FLAT=quat(PI/2)  # torus ring XZ -> XY

def wheel(m,name,parent,pos,r):
    """Bicycle-style wheel in the XY plane, spinning about local Z: tyre and two crossed spokes."""
    w=m.node(name,parent,pos)
    m.part(w,(0,0,0),(r,r,r),"rubber","tire",FLAT)
    for a in [PI/4,-PI/4]:
        m.part(w,(0,0,0),(.008,r*.9,.008),"chrome","box",quat(0,0,a))
    return w

def caster(m,name,parent,pos,r):
    fork=m.node(name+"_Fork",parent,pos)
    h=pos[1]-r
    m.part(fork,(0,-h/2,0),(.008,h/2,.03),"steel_dark")
    w=m.node(name,fork,(0,-h,0))
    m.part(w,(0,0,0),(r,r*2.5,r),"rubber","tire",FLAT)
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

def slide(node,start,end,clip="Open"):
    T=CLIPS[clip]; times=[T*i/6 for i in range(7)]
    return (node,"translation",times,[[start[k]+(end[k]-start[k])*ease(t/T) for k in range(3)] for t in times])

def turn(node,start,end,clip="Open"):
    T=CLIPS[clip]; times=[T*i/6 for i in range(7)]
    return (node,"rotation",times,[quat(*[start[k]+(end[k]-start[k])*ease(t/T) for k in range(3)]) for t in times])

def banh_mi():
    """Vietnamese bánh mì cart: painted cabinet, glass showcase with baguettes, sign with lanterns."""
    m=Model("cart_banh_mi"); root=0
    # Undercarriage: two big wheels at +X, legs at -X, push handle at -X.
    R=.32; ax=.40
    wl=wheel(m,"L_Wheel",root,(ax,R,-.41),R)
    wr=wheel(m,"R_Wheel",root,(ax,R,.41),R)
    m.bar(root,(ax,R,-.44),(ax,R,.44),.012,"steel_dark")
    for z in [-.255,.255]:
        m.bar(root,(-.60,0,z),(-.60,.43,z),.016,"steel_dark")
        m.bar(root,(-.70,.80,z*.94),(-.92,.90,z*.94),.014,"chrome")
    m.bar(root,(-.92,.90,-.27),(-.92,.90,.27),.022,"black")
    # Painted cabinet with yellow band and red panel on the customer side (+Z).
    m.part(root,(0,.63,0),(.70,.21,.31),"teal")
    m.part(root,(0,.70,.312),(.66,.055,.006),"yellow")
    m.part(root,(0,.55,.312),(.58,.07,.005),"red")
    door=m.node("CabinetDoor",root,(-.66,.63,-.313))  # hinge on the left edge, vendor side
    m.part(door,(.32,0,-.006),(.32,.17,.006),"teal_dark")
    m.part(door,(.58,0,-.02),(.012,.012,.012),"chrome")
    m.part(root,(.34,.63,-.319),(.32,.17,.006),"teal_dark")
    m.part(root,(0,.855,0),(.74,.015,.35),"steel")
    # Side shelf with a small charcoal grill over the wheels.
    m.part(root,(.80,.80,0),(.08,.01,.24),"steel")
    m.part(root,(.80,.86,0),(.07,.05,.18),"black")
    m.part(root,(.80,.915,0),(.05,.008,.15),"ember")
    # Glass showcase.
    case=m.node("Showcase",root,(0,.87,0))
    for x in [-.62,.62]:
        for z in [-.24,.24]:
            m.part(case,(x,.23,z),(.012,.23,.012),"chrome")
    m.part(case,(0,.465,0),(.65,.012,.27),"red")
    m.part(case,(0,.445,.262),(.65,.012,.008),"yellow")
    m.part(case,(0,.23,.238),(.61,.22,.003),"glass")
    for x in [-.618,.618]:
        m.part(case,(x,.23,0),(.003,.22,.23),"glass")
    m.part(case,(.31,.23,-.238),(.30,.22,.003),"glass")
    back=m.node("SlidingGlass",case,(-.31,.23,-.226))
    m.part(back,(0,0,0),(.30,.22,.003),"glass")
    m.part(back,(0,-.215,0),(.30,.006,.006),"chrome")
    m.part(case,(0,.24,0),(.60,.006,.22),"steel")
    for i,x in enumerate([-.40,-.12,.16]):
        m.part(case,(x,.04,-.04+(i%2)*.08),(.12,.035,.04),"bread","bead",quat(0,.2*(i-1),0))
    for x in [-.36,-.06]:
        m.part(case,(x,.28,0),(.12,.035,.04),"bread","bead")
    m.part(case,(.45,.26,-.08),(.08,.02,.06),"herb")
    m.part(case,(.45,.26,.08),(.08,.02,.06),"ham")
    m.part(case,(.45,.035,0),(.08,.02,.1),"carrot")
    # Sign board on two poles with hanging lanterns on outrigger arms.
    for x in [-.66,.66]:
        m.bar(root,(x,1.34,-.22),(x,1.82,-.22),.012,"chrome")
    m.part(root,(0,1.66,-.22),(.72,.15,.008),"yellow")
    m.part(root,(0,1.66,-.21),(.69,.125,.008),"red")
    lanterns=[]
    for side,x in [("L",-.84),("R",.84)]:
        m.bar(root,(x*.786,1.78,-.22),(x,1.78,-.22),.008,"chrome")
        hook=m.node(side+"_Lantern",root,(x,1.77,-.22))
        m.part(hook,(0,-.05,0),(.004,.05,.004),"black")
        m.part(hook,(0,-.17,0),(.07,.07,.07),"red","bead")
        lanterns.append(hook)
    L,Rl=lanterns
    m.animation("Idle",[wobble(L,[(2,.10,0),(0,.05,.6)]),wobble(Rl,[(2,.10,1.3),(0,.05,2.1)])])
    m.animation("Roll",[spin(wl,1),spin(wr,1),
                        wobble(L,[(2,.12,0)],base=(0,0,.18),clip="Roll",cycles=2),
                        wobble(Rl,[(2,.12,.9)],base=(0,0,.18),clip="Roll",cycles=2)])
    m.animation("Open",[slide(back,(-.31,.23,-.226),(.29,.23,-.226)),
                        turn(door,(0,0,0),(0,1.7,0))])
    return m.save()

def thai():
    """Thai noodle cart: stainless body, glass box of ingredients, soup pot, striped umbrella."""
    m=Model("cart_thai_noodle"); root=0
    R=.30; ax=.34
    wl=wheel(m,"L_Wheel",root,(ax,R,-.38),R)
    wr=wheel(m,"R_Wheel",root,(ax,R,.38),R)
    m.bar(root,(ax,R,-.41),(ax,R,.41),.012,"steel_dark")
    for z in [-.22,.22]:
        m.bar(root,(-.66,.80,z),(-.88,.92,z),.014,"chrome")
    m.bar(root,(-.88,.92,-.24),(-.88,.92,.24),.022,"black")
    cw=caster(m,"Caster",root,(-.52,.40,0),.08)
    # Gas cylinder on a rack under the body.
    m.part(root,(-.12,.13,0),(.22,.008,.2),"steel_dark")
    for x in [-.32,.08]:
        m.part(root,(x,.265,0),(.008,.135,.18),"steel_dark")
    m.part(root,(-.12,.25,0),(.11,.11,.11),"gas","cyl")
    m.part(root,(-.12,.375,0),(.02,.015,.02),"chrome")
    # Stainless body with a blue front panel.
    m.part(root,(0,.63,0),(.66,.23,.30),"steel")
    m.part(root,(0,.62,.302),(.52,.15,.004),"blue")
    m.part(root,(0,.62,.308),(.48,.025,.004),"white")
    m.part(root,(0,.87,.03),(.69,.012,.36),"steel")
    m.part(root,(0,.885,.39),(.69,.02,.006),"chrome")
    # Glass box with noodles, eggs and limes.
    box=m.node("GlassBox",root,(-.28,.88,-.02))
    for x in [-.30,.30]:
        for z in [-.22,.22]:
            m.part(box,(x,.18,z),(.01,.18,.01),"chrome")
    m.part(box,(0,.365,0),(.31,.008,.23),"chrome")
    m.part(box,(0,.33,.225),(.29,.03,.004),"red")
    m.part(box,(0,.18,.222),(.29,.17,.003),"glass")
    for x in [-.298,.298]:
        m.part(box,(x,.18,0),(.003,.17,.21),"glass")
    lid=m.node("BoxDoor",box,(0,.35,-.222))  # top-hinged flap on the vendor side
    m.part(lid,(0,-.17,0),(.29,.17,.003),"glass")
    m.part(box,(0,.17,0),(.29,.005,.2),"steel")
    for x in [-.15,.12]:
        m.part(box,(x,.04,.04),(.09,.035,.08),"noodle","bead")
    for x in [-.18,-.08]:
        m.part(box,(x,.2,-.08),(.025,.032,.025),"egg","bead")
    for x in [.06,.16]:
        m.part(box,(x,.195,.06),(.025,.025,.025),"lime","bead")
    # Soup pot on a burner; the lid opens in "Open".
    m.part(root,(.36,.90,-.02),(.14,.02,.14),"steel_dark","cyl")
    m.part(root,(.36,1.06,-.02),(.17,.15,.17),"steel","pot")
    m.part(root,(.36,1.2,-.02),(.15,.005,.15),"broth")
    m.part(root,(.36,1.15,-.02),(.21,.008,.025),"steel_dark")
    potlid=m.node("PotLid",root,(.36,1.215,-.19))  # hinge at the back rim
    m.part(potlid,(0,0,.17),(.18,.06,.18),"steel","dome")
    m.part(potlid,(0,.07,.17),(.02,.015,.02),"black")
    # Hanging ladles on a rail along the vendor side.
    m.bar(root,(-.55,1.12,-.36),(.45,1.12,-.36),.008,"chrome")
    for x in [-.55,.45]:
        m.bar(root,(x,.88,-.33),(x,1.12,-.36),.008,"chrome")
    ladles=[]
    for i,x in enumerate([-.35,-.15,.05]):
        hook=m.node("Ladle"+str(i),root,(x,1.11,-.36))
        m.part(hook,(0,-.12,0),(.006,.12,.006),"chrome")
        m.part(hook,(0,-.26,0),(.04,.03,.04),"steel","bead")
        ladles.append(hook)
    # Striped umbrella on a clamp at the back right corner.
    umb=m.node("Umbrella",root,(.62,.88,-.30))
    m.part(umb,(0,0,0),(.03,.03,.03),"steel_dark")
    m.part(umb,(0,.78,0),(.015,.78,.015),"chrome")
    for k in range(8):
        m.part(umb,(0,1.38,0),(1.05,.36,1.05),"canopy_red" if k%2 else "canopy_white","panel",quat(0,2*PI*k/8,0))
    m.animation("Idle",[wobble(umb,[(2,.012,0),(0,.008,1.1)]),
                        *[wobble(l,[(0,.08,i*.9)]) for i,l in enumerate(ladles)]])  # Idle leaves PotLid to Open
    m.animation("Roll",[spin(wl,1),spin(wr,1),spin(cw,4),  # caster: ~R/r turns, rounded for a seamless loop
                        wobble(umb,[(2,.03,0)],clip="Roll",cycles=2),
                        *[wobble(l,[(0,.18,i*.7)],base=(.12,0,0),clip="Roll",cycles=2) for i,l in enumerate(ladles)]])
    m.animation("Open",[turn(potlid,(0,0,0),(-1.15,0,0)),slide(potlid,(.36,1.215,-.19),(.36,1.24,-.19)),
                        turn(lid,(0,0,0),(1.2,0,0))])
    return m.save()

if __name__=="__main__":
    manifest={"units":"meters","up":"+Y","forward":"+Z (customer side)","origin":"cart centre, ground",
              "rig":"rigid node hierarchy; no skinning","colors":"vertex COLOR_0, three materials: paint / glass / cloth",
              "clips":CLIPS,"models":[banh_mi(),thai()]}
    (OUT/"manifest.json").write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+"\n")
    CLIENT.mkdir(parents=True,exist_ok=True)
    for model in manifest["models"]:
        shutil.copyfile(OUT/model["file"],CLIENT/model["file"])
    print(json.dumps([{k:v for k,v in x.items() if k!="animations"} for x in manifest["models"]],ensure_ascii=False))
