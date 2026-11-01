"""Build original low-poly street-food carts. Python 3 standard library only; no Blender required."""
from pathlib import Path
import json, math, struct, shutil

OUT = Path(__file__).resolve().parent
CLIENT = OUT.parents[2] / "client" / "public" / "models" / "carts"
PI = math.pi
CLIPS = {"Idle": 4, "Roll": 2, "Open": 1.5}

def quat(x=0, y=0, z=0):
    # XYZ intrinsic Euler angles, matching Three.js Euler order XYZ.
    a,b,c,d,e,f = math.cos(x/2),math.sin(x/2),math.cos(y/2),math.sin(y/2),math.cos(z/2),math.sin(z/2)
    return [b*c*e+a*d*f, a*d*e-b*c*f, a*c*f+b*d*e, a*c*e-b*d*f]

def sub(a,b): return [a[i]-b[i] for i in range(3)]
def cross(a,b): return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]

def lathe(profile, sides=10, caps=True):
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

def sphere(sides=10, rings=6):
    return lathe([(-math.cos(PI*j/rings),math.sin(PI*j/rings),math.sin(PI*j/rings))
                  for j in range(rings+1)],sides,False)

def cube():
    v=[(x,y,z) for x in [-1,1] for y in [-1,1] for z in [-1,1]]
    f=[]
    for corners in [(0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)]:
        a,b,c,d=corners
        f += [(a,b,c),(a,c,d)]
    return v,f

def torus(tube=.23, n=12, m=4):
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
    # One umbrella sector centred on +X: apex, sagging middle ring, rim at y=0.
    half=PI/sides
    pts=[(0,1,0)]
    for r,y in [(.55,.52),(1,0)]:
        pts += [(r*math.cos(-half),y,r*math.sin(-half)),(r*math.cos(half),y,r*math.sin(half))]
    return pts,[(0,2,1),(1,2,4),(1,4,3)]

SHAPES={
    "sphere":lambda:sphere(), "small":lambda:sphere(8,4), "box":cube,
    "cyl":lambda:lathe([(-1,1,1),(1,1,1)],12), "rod":lambda:lathe([(-1,1,1),(1,1,1)],6),
    "tire":lambda:torus(.10,18,6), "rim":lambda:torus(.06,18,4), "ring":lambda:torus(.23,12,4),
    "pot":lambda:lathe([(-1,.88,.88),(-.85,1,1),(.85,1,1),(1,1.06,1.06),(1,.97,.97),(-.9,.86,.86)],14),
    "dome":lambda:lathe([(0,1,1),(.45,.86,.86),(.8,.5,.5),(1,0,0)],14),
    "wok":lambda:lathe([(-.55,.35,.35),(-.35,.75,.75),(0,1,1),(.05,1.04,1.04),(.02,.96,.96),(-.3,.7,.7),(-.48,.3,.3)],14),
    "panel":panel,
}

class Model:
    def __init__(self, name):
        self.name=name; self.binary=bytearray(); self.cache={}; self.tris={}
        self.g={"asset":{"version":"2.0","generator":"Rest-In-Hackaton procedural carts 1.0"},
                "scene":0,"scenes":[{"name":name,"nodes":[0]}],
                "nodes":[],"meshes":[],"materials":[],"bufferViews":[],"accessors":[],"animations":[]}
        self.materials={}
        self.node(name)
    def mat(self,name,color,metal=0,rough=.82,alpha=1,double=False):
        i=len(self.g["materials"]); self.materials[name]=i
        m={"name":name,"pbrMetallicRoughness":{
            "baseColorFactor":[*color,alpha],"metallicFactor":metal,"roughnessFactor":rough}}
        if alpha<1:m["alphaMode"]="BLEND"
        if double:m["doubleSided"]=True
        self.g["materials"].append(m)
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
    def mesh(self,shape,material):
        key=(shape,material)
        if key in self.cache:return self.cache[key]
        v,f=SHAPES[shape]()
        pos=[]; norm=[]
        for face in f:
            a,b,c=[v[i] for i in face]; n=cross(sub(b,a),sub(c,a)); length=math.sqrt(sum(k*k for k in n))
            if length<1e-9:continue
            n=[k/length for k in n]
            pos.extend([a,b,c]);norm.extend([n,n,n])
        pi=self.accessor(pos,"VEC3",target=34962,bounds=True)
        ni=self.accessor(norm,"VEC3",target=34962)
        ii=self.accessor(list(range(len(pos))),"SCALAR",5123,34963)
        idx=len(self.g["meshes"]);self.cache[key]=idx;self.tris[idx]=len(pos)//3
        self.g["meshes"].append({"name":shape+"_"+material,"primitives":[{
            "attributes":{"POSITION":pi,"NORMAL":ni},"indices":ii,"material":self.materials[material]}]})
        return idx
    def node(self,name,parent=None,pos=None,rot=None,mesh=None,scale=None):
        n={"name":name}
        if pos is not None:n["translation"]=list(pos)
        if rot is not None:n["rotation"]=list(rot)
        if scale is not None:n["scale"]=list(scale)
        if mesh is not None:n["mesh"]=mesh
        i=len(self.g["nodes"]);self.g["nodes"].append(n)
        if parent is not None:self.g["nodes"][parent].setdefault("children",[]).append(i)
        return i
    def part(self,name,parent,pos,scale,mat,shape="box",rot=None):
        return self.node(name,parent,pos,rot,self.mesh(shape,mat),scale)
    def bar(self,name,parent,a,b,r,mat):
        # Round rod between two points (rod axis is local Y).
        d=sub(b,a); length=math.sqrt(sum(k*k for k in d)); d=[k/length for k in d]
        mid=[(a[i]+b[i])/2 for i in range(3)]
        return self.part(name,parent,mid,(r,length/2,r),mat,"rod",_axis_y_to(d))
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
    def save(self):
        self.g["buffers"]=[{"byteLength":len(self.binary)}]
        used=sorted({p["material"] for mesh in self.g["meshes"] for p in mesh["primitives"]})
        remap={old:new for new,old in enumerate(used)}
        self.g["materials"]=[self.g["materials"][old] for old in used]
        for mesh in self.g["meshes"]:
            for primitive in mesh["primitives"]:
                primitive["material"]=remap[primitive["material"]]
        data=json.dumps(self.g,separators=(",",":"),ensure_ascii=False).encode()
        data+=b" "*((-len(data))%4)
        binary=bytes(self.binary)+b"\0"*((-len(self.binary))%4)
        blob=struct.pack("<III",0x46546c67,2,12+8+len(data)+8+len(binary))
        blob+=struct.pack("<II",len(data),0x4e4f534a)+data
        blob+=struct.pack("<II",len(binary),0x004e4942)+binary
        path=OUT/(self.name+".glb");path.write_bytes(blob)
        triangles=sum(self.tris[n["mesh"]] for n in self.g["nodes"] if "mesh" in n)
        assert triangles<=6000,(self.name,triangles)
        assert len(blob)<1_000_000
        return {"file":path.name,"bytes":len(blob),"triangles":triangles,
                "nodes":len(self.g["nodes"]),"animations":[a["name"] for a in self.g["animations"]]}

def _axis_y_to(d):
    # Shortest-arc quaternion rotating +Y onto unit vector d.
    x,y,z=d
    if y<-.999999:return [1,0,0,0]
    q=[z,0,-x,1+y]
    n=math.sqrt(sum(k*k for k in q))
    return [k/n for k in q]

COLORS={
    # name: (rgb, metallic, roughness)
    # Moderate metalness: scenes without an environment map would render full metal almost black.
    "steel":((.74,.76,.76),.45,.35), "steel_dark":((.36,.37,.37),.45,.45), "chrome":((.86,.87,.86),.55,.25),
    "rubber":((.035,.035,.04),0,.9), "black":((.06,.055,.05),.2,.7),
    "teal":((.04,.33,.36),0,.6), "teal_dark":((.02,.19,.21),0,.65),
    "red":((.60,.05,.035),0,.6), "yellow":((.93,.68,.10),0,.55), "gold":((.73,.48,.13),.35,.5),
    "wood":((.42,.22,.10),0,.85), "bread":((.80,.47,.16),0,.8), "bread_dark":((.62,.31,.09),0,.85),
    "herb":((.20,.47,.10),0,.85), "carrot":((.93,.42,.07),0,.8), "ham":((.86,.48,.45),0,.75),
    "coal":((.04,.035,.03),0,.95), "ember":((1.0,.30,.04),0,.6),
    "blue":((.07,.22,.55),0,.6), "white":((.95,.93,.88),0,.75), "noodle":((.95,.80,.36),0,.8),
    "egg":((.98,.95,.86),0,.6), "lime":((.38,.66,.13),0,.6), "sprout":((.93,.92,.78),0,.85),
    "gas":((.72,.07,.05),.3,.45), "broth":((.45,.20,.05),0,.4),
}

def materials(m):
    for name,(c,metal,rough) in COLORS.items():m.mat(name,c,metal,rough)
    m.mat("glass",(.78,.90,.92),0,.08,alpha=.28,double=True)
    m.mat("canopy_red",(.78,.07,.05),0,.75,double=True)
    m.mat("canopy_white",(.96,.94,.88),0,.75,double=True)

def wheel(m,name,parent,pos,r):
    """Bicycle-style wheel in the XY plane, spinning about local Z."""
    w=m.node(name,parent,pos)
    flat=quat(PI/2)  # torus ring XZ -> XY
    m.part(name+"_Tire",w,(0,0,0),(r,r,r),"rubber","tire",flat)
    m.part(name+"_Rim",w,(0,0,0),(r*.88,r*.88,r*.88),"chrome","rim",flat)
    m.part(name+"_Hub",w,(0,0,0),(.032,.045,.032),"steel_dark","cyl",flat)
    for k in range(8):
        a=2*PI*k/8; s=r*.43
        m.part(name+"_Spoke"+str(k),w,(-math.sin(a)*s,math.cos(a)*s,0),(.004,s,.004),"steel","rod",quat(0,0,a))
    return w

def caster(m,name,parent,pos,r):
    fork=m.node(name+"_Fork",parent,pos)
    h=pos[1]-r
    m.part(name+"_Plate",fork,(0,0,0),(.05,.008,.05),"steel_dark")
    for z in [-.03,.03]:
        m.part(name+"_Arm"+str(z),fork,(0,-h/2,z),(.008,h/2,.004),"steel_dark")
    w=m.node(name,fork,(0,-h,0))
    flat=quat(PI/2)
    m.part(name+"_Tire",w,(0,0,0),(r,r*2.5,r),"rubber","tire",flat)
    m.part(name+"_Hub",w,(0,0,0),(r*.7,.025,r*.7),"steel","cyl",flat)
    return fork,w

def spin(node,rev,axis="z",start=0):
    # One clip of Roll: `rev` turns, keyframes every quarter turn (short-arc safe).
    steps=int(rev*4)
    times=[CLIPS["Roll"]*i/steps for i in range(steps+1)]
    rot=lambda a:quat(0,0,a) if axis=="z" else quat(0,a,0) if axis=="y" else quat(a)
    return (node,"rotation",times,[rot(start-PI/2*i) for i in range(steps+1)])

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
    m=Model("cart_banh_mi"); materials(m); root=0
    # Undercarriage: two big wheels at +X, legs at -X, push handle at -X.
    R=.32; ax=.40
    wl=wheel(m,"L_Wheel",root,(ax,R,-.41),R)
    wr=wheel(m,"R_Wheel",root,(ax,R,.41),R)
    m.bar("Axle",root,(ax,R,-.44),(ax,R,.44),.012,"steel_dark")
    for z in [-.30,.30]:
        m.part("AxleBracket"+str(z),root,(ax,.37,z),(.02,.06,.01),"steel_dark")
        m.bar("Leg"+str(z),root,(-.60,.0,z*.85),(-.60,.43,z*.85),.016,"steel_dark")
        m.part("Foot"+str(z),root,(-.60,.008,z*.85),(.03,.008,.03),"rubber")
        m.bar("HandleArm"+str(z),root,(-.70,.80,z*.8),(-.92,.90,z*.8),.014,"chrome")
    m.bar("HandleBar",root,(-.92,.90,-.27),(-.92,.90,.27),.016,"chrome")
    m.part("HandleGrip",root,(-.92,.90,0),(.024,.12,.024),"black","cyl",quat(PI/2))
    # Painted cabinet with yellow band on the customer side (+Z) and doors on the vendor side.
    m.part("Cabinet",root,(0,.63,0),(.70,.21,.31),"teal")
    m.part("Plinth",root,(0,.425,0),(.71,.012,.32),"teal_dark")
    m.part("FrontBand",root,(0,.70,.312),(.66,.055,.006),"yellow")
    m.part("FrontPanel",root,(0,.55,.312),(.58,.07,.005),"red")
    for x in [-.42,0,.42]:
        m.part("FrontStar"+str(x),root,(x,.55,.318),(.035,.035,.004),"yellow","small")
    door=m.node("CabinetDoor",root,(-.66,.63,-.313))  # hinge on the left edge, vendor side
    m.part("DoorPanel",door,(.32,0,-.006),(.32,.17,.006),"teal_dark")
    m.part("DoorKnob",door,(.58,0,-.02),(.012,.012,.012),"chrome","small")
    m.part("DoorFixed",root,(.34,.63,-.319),(.32,.17,.006),"teal_dark")
    m.part("DoorFixedKnob",root,(.06,.63,-.333),(.012,.012,.012),"chrome","small")
    m.part("Counter",root,(0,.855,0),(.74,.015,.35),"steel")
    # Side shelf with a small charcoal grill over the wheels.
    m.part("GrillShelf",root,(.80,.80,0),(.08,.01,.24),"steel")
    m.part("Grill",root,(.80,.86,0),(.07,.05,.18),"black")
    for i,z in enumerate([-.12,-.04,.04,.12]):
        m.part("Ember"+str(i),root,(.80,.915,z),(.045,.012,.03),"ember" if i%2 else "coal","small")
    m.part("GrillRack",root,(.80,.93,0),(.075,.004,.19),"steel_dark")
    # Glass showcase.
    case=m.node("Showcase",root,(0,.87,0))
    for x in [-.62,.62]:
        for z in [-.24,.24]:
            m.part("Post"+str(x)+str(z),case,(x,.23,z),(.012,.23,.012),"chrome")
    m.part("CaseRoof",case,(0,.465,0),(.65,.012,.27),"red")
    m.part("RoofTrim",case,(0,.445,.262),(.65,.012,.008),"yellow")
    m.part("GlassFront",case,(0,.23,.238),(.61,.22,.003),"glass")
    for x in [-.618,.618]:
        m.part("GlassSide"+str(x),case,(x,.23,0),(.003,.22,.23),"glass")
    m.part("GlassBackFixed",case,(.31,.23,-.238),(.30,.22,.003),"glass")
    back=m.node("SlidingGlass",case,(-.31,.23,-.226))
    m.part("SlidingPane",back,(0,0,0),(.30,.22,.003),"glass")
    m.part("SlidingFrame",back,(0,-.215,0),(.30,.006,.006),"chrome")
    m.part("SlidingPull",back,(.24,0,-.01),(.008,.05,.008),"chrome")
    m.part("Shelf",case,(0,.24,0),(.60,.006,.22),"steel")
    # Baguettes: bottom tray and shelf, slightly varied.
    for i in range(5):
        m.part("Baguette"+str(i),case,(-.45+i*.16,.04,-.06+(i%2)*.1),(.12,.035,.04),"bread","sphere",quat(0,.25*(i%3-1),0))
        m.part("Score"+str(i),case,(-.45+i*.16,.07,-.06+(i%2)*.1),(.06,.006,.012),"bread_dark","small",quat(0,.25*(i%3-1),0))
    for i in range(4):
        m.part("ShelfBaguette"+str(i),case,(-.42+i*.2,.28,.02*(i%2)),(.12,.035,.04),"bread","sphere",quat(0,.15*(i%2*2-1),0))
    for i,(mat,z) in enumerate([("herb",-.14),("carrot",0),("ham",.14)]):
        m.part("Tray"+str(i),case,(.47,.255,z),(.08,.012,.06),"steel_dark")
        m.part("Filling"+str(i),case,(.47,.275,z),(.07,.014,.05),mat,"small")
    # Sign board on two poles with hanging lanterns.
    for x in [-.66,.66]:
        m.bar("SignPole"+str(x),root,(x,1.34,-.22),(x,1.82,-.22),.012,"chrome")
    m.part("SignBack",root,(0,1.66,-.22),(.72,.15,.008),"yellow")
    m.part("Sign",root,(0,1.66,-.21),(.69,.125,.008),"red")
    for i in range(6):
        m.part("Glyph"+str(i),root,(-.45+i*.18,1.66,-.199),(.05,.06,.004),"yellow","small" if i%2 else "box")
    lanterns=[]
    for side,x in [("L",-.84),("R",.84)]:
        m.bar(side+"_LanternArm",root,(x*.786,1.78,-.22),(x,1.78,-.22),.008,"chrome")
        hook=m.node(side+"_Lantern",root,(x,1.77,-.22))
        m.part(side+"_Cord",hook,(0,-.05,0),(.003,.05,.003),"black","rod")
        m.part(side+"_LanternCap",hook,(0,-.105,0),(.035,.012,.035),"gold","cyl")
        m.part(side+"_LanternBody",hook,(0,-.17,0),(.07,.065,.07),"red","sphere")
        m.part(side+"_LanternBase",hook,(0,-.235,0),(.03,.01,.03),"gold","cyl")
        m.part(side+"_Tassel",hook,(0,-.28,0),(.01,.035,.01),"yellow","rod")
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
    m=Model("cart_thai_noodle"); materials(m); root=0
    R=.30; ax=.34
    wl=wheel(m,"L_Wheel",root,(ax,R,-.38),R)
    wr=wheel(m,"R_Wheel",root,(ax,R,.38),R)
    m.bar("Axle",root,(ax,R,-.41),(ax,R,.41),.012,"steel_dark")
    for z in [-.26,.26]:
        m.part("AxleBracket"+str(z),root,(ax,.35,z),(.02,.06,.01),"steel_dark")
        m.bar("HandleArm"+str(z),root,(-.66,.80,z*.85),(-.88,.92,z*.85),.014,"chrome")
    m.bar("HandleBar",root,(-.88,.92,-.24),(-.88,.92,.24),.016,"chrome")
    m.part("HandleGrip",root,(-.88,.92,0),(.024,.11,.024),"black","cyl",quat(PI/2))
    fork,cw=caster(m,"Caster",root,(-.52,.40,0),.08)
    # Gas cylinder on a rack under the body.
    m.part("Rack",root,(-.12,.13,0),(.22,.008,.2),"steel_dark")
    for x in [-.32,.08]:
        for z in [-.18,.18]:
            m.bar("RackLeg"+str(x)+str(z),root,(x,.13,z),(x,.40,z),.008,"steel_dark")
    m.part("GasTank",root,(-.12,.24,0),(.11,.10,.11),"gas","cyl")
    m.part("GasDome",root,(-.12,.34,0),(.11,.04,.11),"gas","dome")
    m.part("GasValve",root,(-.12,.385,0),(.02,.012,.02),"chrome","cyl")
    # Stainless body with a blue front panel.
    m.part("Body",root,(0,.63,0),(.66,.23,.30),"steel")
    m.part("BodyTrim",root,(0,.405,0),(.67,.01,.31),"steel_dark")
    m.part("FrontPanel",root,(-.05,.62,.302),(.52,.15,.004),"blue")
    m.part("FrontStripe",root,(-.05,.62,.308),(.48,.025,.004),"white")
    for i in range(4):
        m.part("Rivet"+str(i),root,(-.5+i*.3,.80,.304),(.012,.012,.004),"chrome","small")
    m.part("Counter",root,(0,.87,.03),(.69,.012,.36),"steel")
    m.part("CounterLip",root,(0,.885,.39),(.69,.02,.006),"chrome")
    # Glass box with noodles, eggs, sprouts and limes.
    box=m.node("GlassBox",root,(-.28,.88,-.02))
    for x in [-.30,.30]:
        for z in [-.22,.22]:
            m.part("Frame"+str(x)+str(z),box,(x,.18,z),(.01,.18,.01),"chrome")
    m.part("BoxTop",box,(0,.365,0),(.31,.008,.23),"chrome")
    m.part("BoxSign",box,(0,.33,.225),(.29,.03,.004),"red")
    m.part("GlassFront",box,(0,.18,.222),(.29,.17,.003),"glass")
    for x in [-.298,.298]:
        m.part("GlassSide"+str(x),box,(x,.18,0),(.003,.17,.21),"glass")
    lid=m.node("BoxDoor",box,(0,.35,-.222))  # top-hinged flap on the vendor side
    m.part("BoxDoorPane",lid,(0,-.17,0),(.29,.17,.003),"glass")
    m.part("BoxDoorHandle",lid,(0,-.32,-.012),(.06,.008,.008),"chrome")
    m.part("BoxShelf",box,(0,.17,0),(.29,.005,.2),"steel")
    for i in range(3):
        m.part("Noodles"+str(i),box,(-.18+i*.18,.04,.05),(.075,.035,.075),"noodle","small")
    for i in range(5):
        m.part("Egg"+str(i),box,(-.2+i*.1,.2,-.1),(.025,.032,.025),"egg","small")
    for i in range(4):
        m.part("Lime"+str(i),box,(-.17+i*.11,.195,.08),(.022,.022,.022),"lime","small")
    m.part("Sprouts",box,(.18,.04,-.12),(.08,.03,.06),"sprout","small")
    # Soup pot on a burner, lid opens in "Open".
    m.part("Burner",root,(.36,.90,-.02),(.14,.02,.14),"steel_dark","cyl")
    m.part("Pot",root,(.36,1.06,-.02),(.17,.15,.17),"steel","pot")
    m.part("Broth",root,(.36,1.18,-.02),(.15,.01,.15),"broth","cyl")
    for s in [-1,1]:
        m.part("PotHandle"+str(s),root,(.36+s*.19,1.15,-.02),(.03,.008,.025),"steel_dark","ring")
    potlid=m.node("PotLid",root,(.36,1.215,-.19))  # hinge at the back rim
    m.part("LidDome",potlid,(0,0,.17),(.18,.06,.18),"steel","dome")
    m.part("LidKnob",potlid,(0,.07,.17),(.025,.018,.025),"black","small")
    # Hanging ladles on a rail along the vendor side.
    m.bar("LadleRail",root,(-.55,1.12,-.36),(.45,1.12,-.36),.008,"chrome")
    for x in [-.55,.45]:
        m.bar("RailPost"+str(x),root,(x,.88,-.33),(x,1.12,-.36),.008,"chrome")
    ladles=[]
    for i,x in enumerate([-.35,-.15,.05]):
        hook=m.node("Ladle"+str(i),root,(x,1.11,-.36))
        m.part("LadleStem"+str(i),hook,(0,-.12,0),(.006,.12,.006),"chrome","rod")
        m.part("LadleBowl"+str(i),hook,(0,-.26,0),(.04,.03,.04),"steel","wok")
        ladles.append(hook)
    # Striped umbrella on a clamp at the back right corner.
    umb=m.node("Umbrella",root,(.62,.88,-.30))
    m.part("UmbrellaClamp",umb,(0,0,0),(.03,.03,.03),"steel_dark")
    m.part("UmbrellaPole",umb,(0,.75,0),(.015,.75,.015),"chrome","rod")
    canopy=m.node("Canopy",umb,(0,1.38,0))
    for k in range(8):
        m.part("Panel"+str(k),canopy,(0,0,0),(1.05,.36,1.05),"canopy_red" if k%2 else "canopy_white","panel",quat(0,2*PI*k/8,0))
    m.part("Finial",canopy,(0,.40,0),(.03,.04,.03),"chrome","small")
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
              "rig":"rigid node hierarchy; no skinning","clips":CLIPS,"models":[banh_mi(),thai()]}
    (OUT/"manifest.json").write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+"\n")
    CLIENT.mkdir(parents=True,exist_ok=True)
    for model in manifest["models"]:
        shutil.copyfile(OUT/model["file"],CLIENT/model["file"])
    print(json.dumps(manifest,indent=2,ensure_ascii=False))
