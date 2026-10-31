"""Build original low-poly vendors. Python 3 standard library only; no Blender required."""
from pathlib import Path
import json, math, struct

OUT = Path(__file__).resolve().parent
PI = math.pi

def quat(x=0, y=0, z=0):
    # XYZ intrinsic Euler angles, matching Three.js Euler order XYZ.
    a,b,c,d,e,f = math.cos(x/2),math.sin(x/2),math.cos(y/2),math.sin(y/2),math.cos(z/2),math.sin(z/2)
    return [b*c*e+a*d*f, a*d*e-b*c*f, a*c*f+b*d*e, a*c*e-b*d*f]

def mul(a,b):
    x,y,z,w=a; X,Y,Z,W=b
    return [w*X+x*W+y*Z-z*Y, w*Y-x*Z+y*W+z*X, w*Z+x*Y-y*X+z*W, w*W-x*X-y*Y-z*Z]

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

def torus():
    v=[]; f=[]; n=12; m=4
    for i in range(n):
        u=2*PI*i/n
        for j in range(m):
            t=2*PI*j/m
            v.append(((1+.23*math.cos(t))*math.cos(u),.23*math.sin(t),(1+.23*math.cos(t))*math.sin(u)))
    for i in range(n):
        for j in range(m):
            a=i*m+j; b=((i+1)%n)*m+j; c=((i+1)%n)*m+(j+1)%m; d=i*m+(j+1)%m
            # Tube parameterization: major tangent cross minor tangent points outward.
            f += [(a,d,c),(a,c,b)]
    return v,f

class Model:
    def __init__(self, name):
        self.name=name; self.binary=bytearray(); self.cache={}; self.tris={}
        self.g={"asset":{"version":"2.0","generator":"Rest-In-Hackaton procedural vendors 1.0"},
                "scene":0,"scenes":[{"name":name,"nodes":[0]}],
                "nodes":[],"meshes":[],"materials":[],"bufferViews":[],"accessors":[],"animations":[]}
        self.materials={}
        self.node(name)
    def mat(self,name,color,metal=0,rough=.82):
        i=len(self.g["materials"]); self.materials[name]=i
        self.g["materials"].append({"name":name,"pbrMetallicRoughness":{
            "baseColorFactor":[*color,1],"metallicFactor":metal,"roughnessFactor":rough}})
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
        if shape=="sphere":v,f=sphere()
        elif shape=="small":v,f=sphere(8,4)
        elif shape=="box":v,f=cube()
        elif shape=="torus":v,f=torus()
        elif shape=="body":v,f=lathe([(-1,.70,.82),(-.65,.94,1),(.1,1,1),(.75,.87,.82),(1,.66,.68)],10)
        elif shape=="cap":v,f=lathe([(0,1,1),(.45,.93,.95),(.8,.65,.68),(1,0,0)],10)
        elif shape=="bowl":v,f=lathe([(-.6,.45,.45),(-.45,.65,.65),(0,1,1),(.15,1.04,1.04),(.15,.89,.89),(-.32,.55,.55)],12)
        elif shape=="hat":v,f=lathe([(-1,.70,.70),(-.5,.76,.76),(-.15,1.0,.93),(.65,.98,.95),(1,.66,.70)],10)
        elif shape=="boot":v,f=lathe([(-1,.83,.95),(-.65,1,1),(.25,.90,.95),(1,.74,.66)],8)
        else:raise ValueError(shape)
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
    def part(self,name,parent,pos,scale,mat,shape="sphere",rot=None):
        return self.node(name,parent,pos,rot,self.mesh(shape,mat),scale)
    def animation(self,name,channels):
        anim={"name":name,"samplers":[],"channels":[]}
        for node,path,times,values in channels:
            inp=self.accessor(times,"SCALAR",bounds=True)
            out=self.accessor(values,"VEC4" if path=="rotation" else "VEC3")
            # q and -q represent the same pose; keep interpolation on the short arc.
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
        assert triangles<=4000,(self.name,triangles)
        assert len(blob)<1_000_000
        return {"file":path.name,"bytes":len(blob),"triangles":triangles,
                "nodes":len(self.g["nodes"]),"animations":[a["name"] for a in self.g["animations"]]}

def build(chef=False):
    m=Model("chef_chen" if chef else "lao_wang")
    colors={"skin":(.68,.39,.22),"skin_light":(.83,.56,.36),"blush":(.66,.28,.18),
            "cream":(.89,.84,.69),"white":(.97,.94,.83),"navy":(.035,.09,.15),
            "navy_edge":(.09,.18,.25),"brown":(.22,.115,.065),"pants":(.10,.14,.16),
            "shoe":(.055,.045,.035),"sole":(.14,.13,.11),"grey":(.51,.55,.52),
            "hair":(.10,.065,.045),"dark":(.035,.028,.02),"eye":(.985,.96,.87),
            "jade":(.045,.43,.27),"gold":(.73,.48,.13),"red":(.57,.065,.035),
            "red_edge":(.80,.18,.065),"bowl":(.10,.31,.38),"bowl_rim":(.29,.61,.60),
            "broth":(.34,.14,.025),"noodle":(.92,.64,.23),"green":(.18,.38,.055)}
    for name,c in colors.items():m.mat(name,c,.35 if name=="gold" else .08 if name=="jade" else 0,.32 if name=="jade" else .82)
    root=0
    # Shoes have a flat sole at ground level; separated pant legs articulate cleanly.
    for side,x in [("L",-.115),("R",.115)]:
        m.part(side+"_Sole",root,(x,.026,.045),(.094,.026,.165),"sole","box")
        m.part(side+"_Shoe",root,(x,.083,.045),(.092,.057,.158),"shoe","boot")
        m.part(side+"_Trouser",root,(x,.445,0),(.104,.33,.113),"pants" if chef else "brown","body")
        m.part(side+"_Cuff",root,(x,.17,.0),(.103,.04,.112),"pants" if chef else "brown","box")
    hips=m.part("Hips",root,(0,.77,0),(.225 if chef else .20,.105,.14),"pants" if chef else "brown","body")
    upper=m.node("UpperBody",root,(0,.83,0))
    width=.285 if chef else .245
    m.part("Shirt",upper,(0,.255,0),(width,.275,.175 if chef else .15),"cream" if chef else "navy","body")
    m.part("Belt",upper,(0,.015,.012),(width*.77,.026,.145),"brown" if chef else "navy_edge","box")
    # Collar triangles represented by shallow faceted diamond folds.
    m.part("ShirtFront",upper,(0,.395,.118),(.088,.13,.034),"white","small")
    for side in [-1,1]:
        m.part(("L" if side<0 else "R")+"_Collar",upper,(side*.06,.442,.128),(.059,.055,.024),"white","small",quat(0,0,side*.42))
    m.part("Neck",upper,(0,.53,0),(.082,.09,.078),"skin","small")
    head=m.node("Head",upper,(0,.69,.014))
    m.part("Face",head,(0,0,0),(.192 if chef else .181,.219,.175),"skin_light")
    m.part("Chin",head,(0,-.133,.027),(.13,.065,.117),"skin_light","small")
    for s in [-1,1]:
        tag="L" if s<0 else "R"
        m.part(tag+"_Ear",head,(s*.185,-.015,-.006),(.037,.062,.035),"skin","small")
        m.part(tag+"_Cheek",head,(s*.104,-.065,.136),(.045,.023,.020),"blush","small")
        m.part(tag+"_EyeWhite",head,(s*.073,.025,.153),(.043,.039,.025),"eye","small")
        m.part(tag+"_Pupil",head,(s*.073,.024,.175),(.019,.025,.008),"dark","small")
        m.part(tag+"_EyeLight",head,(s*.068,.033,.183),(.006,.008,.003),"white","small")
        m.part(tag+"_Eyebrow",head,(s*.075,.079,.157),(.050,.011,.014),"hair" if chef else "grey","box",quat(0,0,-s*.13))
    m.part("Nose",head,(0,-.017,.185),(.040,.047,.045),"skin","small")
    m.part("Smile",head,(0,-.109,.156),(.047,.009,.012),"dark","small")
    m.part("LowerLip",head,(0,-.121,.147),(.033,.008,.010),"skin","small")
    if chef:
        m.part("HatBand",head,(0,.169,-.01),(.198,.056,.178),"white","box")
        m.part("ChefHat",head,(0,.316,-.024),(.224,.145,.19),"white","hat")
        for x,y in [(-.115,.423),(0,.446),(.115,.423)]:
            m.part("HatPuff_"+str(x),head,(x,y,-.02),(.103,.064,.153),"white","small")
        m.part("ApronBib",upper,(0,.306,.18),(.152,.183,.023),"red","box")
        m.part("ApronSkirt",upper,(0,-.018,.155),(.202,.178,.025),"red","body")
        m.part("ApronPocket",upper,(0,.167,.208),(.085,.049,.009),"red_edge","box")
        for s in [-1,1]:
            m.part("ApronStrap_"+str(s),upper,(s*.113,.463,.136),(.022,.077,.014),"red","box",quat(.20,0,-s*.18))
            m.part("ApronTie_"+str(s),upper,(s*.225,.04,0),(.025,.020,.145),"red_edge","box")
        m.part("ApronKnot",upper,(0,.045,-.167),(.055,.032,.025),"red_edge","small")
    else:
        m.part("SilverHair",head,(0,.148,-.018),(.188,.092,.177),"grey","cap")
        for s in [-1,1]:
            m.part("Sideburn_"+str(s),head,(s*.167,.08,-.024),(.030,.077,.083),"grey","small")
            m.part("Moustache_"+str(s),head,(s*.033,-.080,.176),(.046,.019,.025),"grey","small",quat(0,0,-s*.20))
            m.part("VestEdge_"+str(s),upper,(s*.105,.30,.143),(.017,.183,.014),"navy_edge","box",quat(0,0,s*.20))
        for y in [.13,.22,.31]:
            m.part("BrassButton_"+str(y),upper,(0,y,.165),(.011,.011,.006),"gold","small")
        m.part("VestPocket",upper,(-.135,.115,.137),(.048,.038,.009),"navy_edge","box")
    # Arms: shoulders -> elbows -> wrists; props remain attached during every clip.
    arm_nodes={}
    for side,sign in [("L",-1),("R",1)]:
        q=quat(-.22 if side=="R" else 0,0,sign*.12)
        shoulder=m.node(side+"_Shoulder",upper,(sign*(width*.9),.437,0),q)
        m.part(side+"_Sleeve",shoulder,(0,-.115,0),(.082,.145,.089),"cream","body")
        elbow=m.node(side+"_Elbow",shoulder,(0,-.248,0),quat(-1.05 if side=="R" else -.12))
        m.part(side+"_Forearm",elbow,(0,-.093,0),(.059,.112,.062),"skin","body")
        m.part(side+"_SleeveCuff",elbow,(0,-.015,0),(.065,.034,.068),"white","box")
        wrist=m.node(side+"_Wrist",elbow,(0,-.207,0))
        m.part(side+"_Palm",wrist,(0,-.035,.0),(.052,.058,.031),"skin_light","small")
        for i in range(3):
            m.part(side+"_Finger_"+str(i),wrist,((i-1)*.026,-.079,.008),(.014,.024,.019),"skin","small")
        m.part(side+"_Thumb",wrist,(-sign*.048,-.025,.023),(.024,.031,.021),"skin_light","small",quat(0,0,sign*.4))
        arm_nodes[side]=(shoulder,elbow,wrist)
    right=arm_nodes["R"][2]
    # Cancel rest arm rotation for upright bowl/pendant, still inherit all animated motion.
    total=mul(quat(-.22,0,.12),quat(-1.05))
    inv=[-total[0],-total[1],-total[2],total[3]]
    prop=m.node("HeldProp",right,(0,-.04,.035),inv)
    if chef:
        m.part("CeramicBowl",prop,(0,.016,0),(.145,.14,.145),"bowl","bowl")
        m.part("BowlRim",prop,(0,.038,0),(.127,.027,.127),"bowl_rim","torus")
        # Surface is below the visible rim; individually faceted noodles and scallions.
        m.part("Broth",prop,(0,.027,0),(.126,.008,.126),"broth","small")
        for i in range(5):
            x=(i-2)*.032
            m.part("Noodle_"+str(i),prop,(x,.043,.0),(.010,.008,.091-abs(x)*.5),"noodle","box",quat(0,(i-2)*.17,0))
        for i,(x,z) in enumerate([(-.06,.04),(.03,-.06),(.065,.035)]):
            m.part("Scallion_"+str(i),prop,(x,.056,z),(.022,.008,.016),"green","small")
        for i in [-1,1]:
            m.part("Chopstick_"+str(i),prop,(.092+i*.014,.081,-.023),(.006,.006,.17),"brown","box",quat(0,-.25,0))
    else:
        m.part("JadePendant",prop,(0,-.090,.016),(.042,.018,.042),"jade","torus",quat(PI/2))
        m.part("GoldLoop",prop,(0,-.038,.016),(.010,.008,.010),"gold","torus",quat(PI/2))
        m.part("PendantCord",prop,(0,-.009,.014),(.003,.026,.003),"brown","box")
        m.part("JadeTassel",prop,(0,-.154,.016),(.013,.026,.009),"red","body")
    left,elbow,wrist=arm_nodes["L"]
    m.animation("Idle",[
        (upper,"translation",[0,1,2,3,4],[[0,.83,0],[0,.835,0],[0,.83,0],[0,.827,0],[0,.83,0]]),
        (head,"rotation",[0,1,2,3,4],[quat(0,0,0),quat(.012,.025,.009),quat(),quat(-.008,-.025,-.009),quat()]),
        (left,"rotation",[0,2,4],[quat(0,0,-.12),quat(.035,0,-.15),quat(0,0,-.12)])])
    times=[0,.35,.65,.95,1.25,1.55,2]
    m.animation("Wave",[
        (left,"rotation",times,[quat(0,0,z) for z in [-.12,-2.25,-2.48,-2.18,-2.48,-2.25,-.12]]),
        (elbow,"rotation",times,[quat(-.12,0,z) for z in [0,-.30,-.44,-.22,-.44,-.30,0]]),
        (wrist,"rotation",times,[quat(0,0,z) for z in [0,-.15,.18,-.15,.18,-.15,0]]),
        (head,"rotation",[0,1,2],[quat(),quat(.045,-.06,-.025),quat()])])
    return m.save()

if __name__=="__main__":
    manifest={"units":"meters","up":"+Y","forward":"+Z","origin":"between feet, ground",
              "rig":"rigid node hierarchy; no skinning","models":[build(),build(True)]}
    (OUT/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
    print(json.dumps(manifest,indent=2))
