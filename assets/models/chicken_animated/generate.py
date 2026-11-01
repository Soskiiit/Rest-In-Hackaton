"""Rig and animate Jeremy's supplied chicken. Standard library only; source.glb stays unchanged."""
from pathlib import Path
import json,math,struct,hashlib
ROOT=Path(__file__).resolve().parent
class Export:
 def __init__(self,materials):
  self.bin=bytearray();self.g={'asset':{'version':'2.0','generator':'Rest-In-Hackaton chicken rig 1.0','extras':{'source':'Chicken by jeremy - 1YE8U35HXsI.glb','source_author':'jeremy'}},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'name':'Chicken','children':[]}],'meshes':[],'materials':materials,'accessors':[],'bufferViews':[],'skins':[],'animations':[]}
 def acc(self,rows,kind,component=5126,target=None):
  n={'SCALAR':1,'VEC3':3,'VEC4':4,'MAT4':16}[kind];rows=list(rows);flat=rows if n==1 else [v for r in rows for v in r];fmt={5126:'f',5123:'H',5125:'I'}[component]
  while len(self.bin)%4:self.bin.append(0)
  view={'buffer':0,'byteOffset':len(self.bin),'byteLength':len(flat)*struct.calcsize(fmt)}
  if target:view['target']=target
  self.bin.extend(struct.pack('<'+fmt*len(flat),*flat));vi=len(self.g['bufferViews']);self.g['bufferViews'].append(view)
  a={'bufferView':vi,'componentType':component,'type':kind,'count':len(rows)}
  if n==1:a.update(min=[min(rows)],max=[max(rows)])
  elif kind=='VEC3':a.update(min=[min(r[i]for r in rows)for i in range(3)],max=[max(r[i]for r in rows)for i in range(3)])
  i=len(self.g['accessors']);self.g['accessors'].append(a);return i
 def node(self,name,parent,pos=(0,0,0)):
  i=len(self.g['nodes']);self.g['nodes'].append({'name':name,'translation':list(pos)});self.g['nodes'][parent].setdefault('children',[]).append(i);return i
 def mesh(self,name,material,vertices,normals,weights):
  joints=[];values=[]
  for weight in weights:
   parts=sorted(((i,w)for i,w in weight.items()if w>1e-7),key=lambda p:p[1],reverse=True)[:4];total=sum(v for _,v in parts);joints.append([i for i,_ in parts]+[0]*(4-len(parts)));values.append([v/total for _,v in parts]+[0]*(4-len(parts)))
  primitive={'attributes':{'POSITION':self.acc(vertices,'VEC3',target=34962),'NORMAL':self.acc(normals,'VEC3',target=34962),'JOINTS_0':self.acc(joints,'VEC4',5123,34962),'WEIGHTS_0':self.acc(values,'VEC4',target=34962)},'indices':self.acc(range(len(vertices)),'SCALAR',5125,34963),'material':material}
  mi=len(self.g['meshes']);self.g['meshes'].append({'name':name,'primitives':[primitive]});node=self.node(name,0);self.g['nodes'][node].update(mesh=mi,skin=0);self.g['nodes'][0]['children'].remove(node);self.g['scenes'][0]['nodes'].append(node)
 def anim(self,name,tracks):
  a={'name':name,'channels':[],'samplers':[]}
  for node,path,times,values in tracks:
   i=len(a['samplers']);a['samplers'].append({'input':self.acc(times,'SCALAR'),'output':self.acc(values,'VEC4'if path=='rotation'else'VEC3'),'interpolation':'LINEAR'});a['channels'].append({'sampler':i,'target':{'node':node,'path':path}})
  self.g['animations'].append(a)
 def save(self):
  self.g['buffers']=[{'byteLength':len(self.bin)}];js=json.dumps(self.g,separators=(',',':')).encode();js+=b' '*(-len(js)%4);data=bytes(self.bin)+b'\0'*(-len(self.bin)%4)
  blob=struct.pack('<III',0x46546c67,2,28+len(js)+len(data))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(data),0x004e4942)+data
  (ROOT/'chicken_animated.glb').write_bytes(blob);return len(blob)
def q(x=0,y=0,z=0):
 a,b,c,d,e,f=math.cos(x/2),math.sin(x/2),math.cos(y/2),math.sin(y/2),math.cos(z/2),math.sin(z/2)
 return [b*c*e+a*d*f,a*d*e-b*c*f,a*c*f+b*d*e,a*c*e-b*d*f]
def main():
 source=(ROOT/'source.glb').read_bytes();size=struct.unpack_from('<I',source,12)[0];doc=json.loads(source[20:20+size]);binary=source[28+size:]
 def read(i):
  a=doc['accessors'][i];v=doc['bufferViews'][a['bufferView']];n={'SCALAR':1,'VEC3':3}[a['type']];f={5126:'f',5123:'H',5125:'I'}[a['componentType']];width=struct.calcsize(f)*n;offset=v.get('byteOffset',0)+a.get('byteOffset',0)
  return [struct.unpack_from('<'+f*n,binary,offset+k*v.get('byteStride',width))for k in range(a['count'])]
 scale=.6/(190.3115692138672-1.2920769453048706)
 def point(p):return [p[2]*scale,(p[1]-1.2920769453048706)*scale,(-p[0]-10.5)*scale]
 def normal(n):return [n[2],n[1],-n[0]]
 e=Export(doc['materials']);skeleton=e.node('Armature',0);joints=[];world=[];bind={};ids={}
 def bone(name,parent,position):
  offset=[position[k]-(world[parent][k]if parent is not None else 0)for k in range(3)];node=e.node(name,joints[parent]if parent is not None else skeleton,offset);index=len(joints);joints.append(node);world.append(position);bind[node]=offset;ids[name]=index;return index
 body=bone('Body',None,[0,.22,-.033]);neck=bone('Neck',body,[0,.36,.10]);head=bone('Head',neck,[0,.445,.16]);tail=bone('Tail',body,[0,.27,-.16])
 wl=bone('Wing_L',body,[.07,.34,-.035]);wr=bone('Wing_R',body,[-.07,.34,-.035])
 legs=[]
 for sign,label in [(1,'L'),(-1,'R')]:
  leg=bone('Leg_'+label,None,[sign*.115,.09,0]);foot=bone('Foot_'+label,leg,[sign*.115,.022,0]);toes=bone('Toes_'+label,foot,[sign*.115,.004,.035]);legs.append((leg,foot,toes,sign))
 matrices=[]
 for x,y,z in world:matrices.append([1,0,0,0,0,1,0,0,0,0,1,0,-x,-y,-z,1])
 e.g['skins']=[{'name':'ChickenRig','joints':joints,'skeleton':skeleton,'inverseBindMatrices':e.acc(matrices,'MAT4')}]
 def weights(p,mat):
  x,y,z=p
  if mat==4:return {legs[0 if x>0 else 1][2]:1}
  if mat==0 and y<.085:
   leg,foot,_,_=legs[0 if x>0 else 1];t=max(0,min(1,(y-.025)/.045));return {foot:1-t,body:t}if 0<t<1 else {body if t else foot:1}
  if mat in [2,3] or (mat==0 and y>.35):return {head:1}
  if y>.34 and z>.065:
   t=max(0,min(1,(y-.34)/.095));return {neck:1-t,head:t}
  if y>.25 and z>.06:
   t=max(0,min(1,(y-.25)/.09));return {body:1-t,neck:t}
  if z<-.18 and y>.26:return {tail:1}
  return {body:1}
 tri_count=0
 for prim in doc['meshes'][0]['primitives']:
  positions=read(prim['attributes']['POSITION']);normals=read(prim['attributes']['NORMAL']);indices=[r[0]for r in read(prim['indices'])];mat=prim['material'];verts=[];ns=[];ws=[];patch={wl:([],[],[]),wr:([],[],[])}
  def triangle(v,n,depth):
   if depth:
    ab=[(v[0][k]+v[1][k])/2 for k in range(3)];bc=[(v[1][k]+v[2][k])/2 for k in range(3)];ca=[(v[2][k]+v[0][k])/2 for k in range(3)]
    def avg(a,b):
     r=[(a[k]+b[k])/2 for k in range(3)];l=math.sqrt(sum(x*x for x in r))or 1;return [x/l for x in r]
    nab,nbc,nca=avg(n[0],n[1]),avg(n[1],n[2]),avg(n[2],n[0])
    for vv,nn in [([v[0],ab,ca],[n[0],nab,nca]),([ab,v[1],bc],[nab,n[1],nbc]),([ca,bc,v[2]],[nca,nbc,n[2]]),([ab,bc,ca],[nab,nbc,nca])]:triangle(vv,nn,depth-1)
    return
   verts.extend(v);ns.extend(n);ws.extend(weights(p,mat)for p in v)
   x,y,z=[sum(p[k]for p in v)/3 for k in range(3)]
   if mat==1 and abs(x)>.075 and .14<y<.34 and -.17<z<.045:
    wing=wl if x>0 else wr;pv,pn,pw=patch[wing]
    pv.extend([[p[k]+nn[k]*.0012 for k in range(3)]for p,nn in zip(v,n)]);pn.extend(n);pw.extend({wing:1}for _ in v)
  for i in range(0,len(indices),3):
   ids0=indices[i:i+3];triangle([point(positions[k])for k in ids0],[normal(normals[k])for k in ids0],2 if mat==1 else 0)
  e.mesh('ChickenMaterial_'+str(mat),mat,verts,ns,ws);tri_count+=len(verts)//3
  for wing,(pv,pn,pw)in patch.items():
   if pv:
    # A thin two-sided feather shell gives the underside real geometry during flapping.
    vv=list(pv);nn=list(pn);ww=list(pw)
    for k in range(0,len(pv),3):
     front=pv[k:k+3];norm=pn[k:k+3];back=[[v[j]-n[j]*.007 for j in range(3)]for v,n in zip(front,norm)]
     vv.extend([back[2],back[1],back[0]]);nn.extend([[-x for x in n]for n in reversed(norm)]);ww.extend([{wing:1}]*3)
    e.mesh('FeatherPanel_'+('L'if wing==wl else'R'),mat,vv,nn,ww);tri_count+=len(vv)//3
 # Pixel sunglasses are fully weighted to Head, including temples and bridge.
 black=len(e.g['materials']);e.g['materials'].append({'name':'PixelBlack','pbrMetallicRoughness':{'baseColorFactor':[.002,.002,.003,1],'metallicFactor':0,'roughnessFactor':.92}})
 shine=len(e.g['materials']);e.g['materials'].append({'name':'PixelReflection','pbrMetallicRoughness':{'baseColorFactor':[.25,.29,.31,1],'metallicFactor':0,'roughnessFactor':.6}})
 def box(center,size,yaw,material,name):
  verts=[];norms=[];co,si=math.cos(yaw),math.sin(yaw)
  points=[(x*size[0]/2,y*size[1]/2,z*size[2]/2)for x in [-1,1]for y in [-1,1]for z in [-1,1]]
  for corners in [(0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)]:
   a,b,c,d=corners
   for face in [(a,b,c),(a,c,d)]:
    pts=[points[i]for i in face];u=[pts[1][k]-pts[0][k]for k in range(3)];v=[pts[2][k]-pts[0][k]for k in range(3)];n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];l=math.sqrt(sum(t*t for t in n));n=[t/l for t in n]
    for x,y,z in pts:verts.append([center[0]+co*x+si*z,center[1]+y,center[2]-si*x+co*z]);norms.append([co*n[0]+si*n[2],n[1],-si*n[0]+co*n[2]])
  e.mesh(name,material,verts,norms,[{head:1}for _ in verts]);return len(verts)//3
 for sign in [-1,1]:
  yaw=sign*.90;cx,cy,cz=sign*.046,.481,.177
  for row in range(3):
   for column in range(6):
    if row==2 and column in [0,5]:continue
    u=(column-2.5)*.008
    center=[cx+math.cos(yaw)*u,cy+(.5-row)*.008,cz-math.sin(yaw)*u]
    tri_count+=box(center,[.0081,.0081,.006],yaw,black,'PixelLens_'+str(sign)+'_'+str(row)+'_'+str(column))
  for column in [1,2]:
   u=(column-2.5)*.008
   tri_count+=box([cx+math.cos(yaw)*u+sign*.0025,cy+.001,cz-math.sin(yaw)*u+.003],[.006,.003,.002],yaw,shine,'LensGlint_'+str(sign)+'_'+str(column))
  tri_count+=box([sign*.061,.489,.146],[.008,.008,.055],0,black,'Temple_'+str(sign))
 tri_count+=box([0,.490,.196],[.070,.008,.008],0,black,'PixelBridge')
 neutral={j:('translation',bind[j])for j in joints}
 def clip(name,duration,poses):
  times=[duration*i/(len(poses)-1)for i in range(len(poses))];tracks=[]
  for index,node in enumerate(joints):
   tracks.append((node,'translation',times,[p.get((index,'translation'),bind[node])for p in poses]))
   tracks.append((node,'rotation',times,[p.get((index,'rotation'),q())for p in poses]))
  e.anim(name,tracks)
 def run(panic):
  poses=[];duration=.52 if panic else .72
  for i in range(33):
   phase=2*math.pi*i/32;p={};bob=.018*(1-math.cos(phase*2))/2
   p[body,'translation']=[0,.22+bob+(.025 if panic else 0),-.033];p[body,'rotation']=q(.10 if panic else .05*math.sin(phase*2),0,.04*math.sin(phase))
   p[neck,'rotation']=q(.10 if panic else .06*math.sin(phase*2));p[head,'rotation']=q(.05*math.sin(phase*2));p[tail,'rotation']=q(.09*math.sin(phase*2))
   for leg,foot,toes,sign in legs:
    # +Z is forward: planted half-cycle travels toward -Z; lifted half returns +Z.
    t=phase+(0 if sign>0 else math.pi);p[foot,'translation']=[0,-.068+.055*max(0,math.sin(t)),-.047*math.cos(t)];p[leg,'rotation']=q();p[toes,'rotation']=q(-.08*max(0,math.sin(t)))
   flap=(.85+.75*math.sin(phase*2))if panic else .04*math.sin(phase)
   p[wl,'rotation']=q(0,0,flap);p[wr,'rotation']=q(0,0,-flap);poses.append(p)
  clip('PanicRun'if panic else'Run',duration,poses)
 run(False)
 poses=[]
 for dip in [0,.3,.8,1,.7,1,.65,1,.35,0]:
  p={(body,'translation'):[0,.22-.025*dip,-.033],(body,'rotation'):q(.12*dip),(neck,'translation'):[0,.14-.185*dip,.133+.06*dip],(neck,'rotation'):q(1.24*dip),(head,'rotation'):q(.18*dip),(tail,'rotation'):q(-.15*dip)};poses.append(p)
 clip('Peck',2.4,poses);run(True)
 size=e.save();manifest={'file':'chicken_animated.glb','source_sha256':hashlib.sha256(source).hexdigest(),'bytes':size,'triangles':tri_count,'bones':len(joints),'height_m':.6,'accessory':'head-bound pixel sunglasses','gait':'planted feet travel toward -Z; swing feet toward +Z','units':'meters','forward':'+Z','up':'+Y','root_motion':False,'clips':{'Run':{'duration':.72,'loop':True},'Peck':{'duration':2.4,'loop':False},'PanicRun':{'duration':.52,'loop':True}}};(ROOT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest))
if __name__=='__main__':main()
