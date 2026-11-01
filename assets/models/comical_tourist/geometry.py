"""Low-poly articulated geometry and GLB writer. Python 3 standard library only."""
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

def sweep(path,radii):
    vertices=[];faces=[];sides=4
    for i,((x,y),r) in enumerate(zip(path,radii)):
        prev=path[max(0,i-1)];nxt=path[min(len(path)-1,i+1)]
        dx,dy=nxt[0]-prev[0],nxt[1]-prev[1];length=math.hypot(dx,dy) or 1
        nx,ny=-dy/length,dx/length
        for k in range(sides):
            a=2*PI*k/sides
            vertices.append((x+nx*r*math.cos(a),y+ny*r*math.cos(a),r*math.sin(a)))
    for i in range(len(path)-1):
        for k in range(sides):
            a=i*sides+k;b=i*sides+(k+1)%sides;c=a+sides;d=b+sides
            faces.extend([(a,b,d),(a,d,c)])
    for start in [0,(len(path)-1)*sides]:
        if start==0:faces.extend([(start,start+2,start+1),(start,start+3,start+2)])
        else:faces.extend([(start,start+1,start+2),(start,start+2,start+3)])
    return vertices,faces

class Model:
    def __init__(self, name):
        self.name=name; self.binary=bytearray(); self.cache={}; self.tris={}
        self.g={"asset":{"version":"2.0","generator":"Rest-In-Hackaton comical tourist 1.0"},
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
        if shape=="limb":v,f=lathe([(-1,0,0),(-1,1,1),(1,.90,.90),(1,0,0)],6,False)
        elif shape=="shirt":v,f=lathe([(-1,0,0),(-1,.78,.85),(-.5,1,1),(.65,.85,.85),(1,.65,.68),(1,0,0)],8,False)
        elif shape=="cylinder":v,f=lathe([(-1,0,0),(-1,1,1),(1,1,1),(1,0,0)],8,False)
        elif shape=="panama":v,f=lathe([(-.06,0,0),(-.06,1,1),(.02,1.03,1.03),(.12,.74,.77),(.90,.64,.67),(1,.47,.48),(1,0,0)],10,False)
        elif shape=="hat_band":v,f=lathe([(.25,.728,.758),(.40,.708,.738)],10,False)
        elif shape=="sphere":v,f=sphere(8,4)
        elif shape=="head":v,f=sphere(10,5)
        elif shape=="cone":v,f=lathe([(0,1,1),(.08,1,1),(1,.025,.025)],12)
        elif shape=="mustache":v,f=sweep([(0,0),(.09,-.04),(.17,-.14),(.22,-.28),(.23,-.40)],[.045,.043,.035,.02,.001])
        elif shape=="mustache_up":v,f=sweep([(0,0),(.10,-.015),(.22,.015),(.31,.10),(.34,.21),(.30,.26)],[.036,.04,.035,.028,.018,.001])
        elif shape=="eye_arc":v,f=sweep([(-.105,0),(-.055,.04),(0,.052),(.055,.04),(.105,0)],[.009,.014,.015,.014,.009])
        elif shape=="smile":v,f=sweep([(-.065,.02),(-.035,-.01),(0,-.02),(.035,-.01),(.065,.02)],[.006,.009,.009,.009,.006])
        elif shape=="small":v,f=sphere(6,3)
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
        assert triangles<=2000,(self.name,triangles)
        assert len(blob)<1_000_000
        return {"file":path.name,"bytes":len(blob),"triangles":triangles,
                "nodes":len(self.g["nodes"]),"animations":[a["name"] for a in self.g["animations"]]}
