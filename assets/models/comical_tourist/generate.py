"""Build the standalone tourist and seven grounded clips; standard library only."""
from pathlib import Path
import json,math,struct,hashlib
from geometry import Model,quat
OUT=Path(__file__).resolve().parent
P=math.pi

def build():
 m=Model('comical_tourist')
 for name,color in {'skin':(.96,.70,.50),'shirt':(.025,.47,.43),'sand':(.67,.48,.23),'hat':(.91,.86,.68),'ink':(.035,.055,.065),'white':(.96,.96,.88),'hair':(.23,.095,.035),'bag':(.76,.42,.045),'lens':(.08,.32,.43),'blush':(.87,.40,.25)}.items():m.mat(name,color)
 pivot=m.node('ActionPivot',0,(0,0,0),quat());hips=m.node('Hips',pivot,(0,.55,0),quat());torso=m.node('Torso',hips,(0,.40,0),quat())
 m.part('Shirt',torso,(0,.065,0),(.26,.32,.19),'shirt','shirt')
 m.part('Neck',torso,(0,.39,0),(.085,.10,.08),'skin','limb')
 for side in [-1,1]:m.part('Collar_'+str(side),torso,(side*.067,.35,.14),(.06,.035,.025),'white','box',quat(0,0,side*.30))
 m.part('ButtonSeam',torso,(0,.12,.191),(.009,.21,.008),'shirt','box')
 for i in range(3):m.part('Button_'+str(i),torso,(0,.28-i*.105,.202),(.013,.013,.009),'white','small')
 head=m.node('Head',torso,(0,.65,0),quat());m.part('BigHead',head,(0,0,0),(.31,.32,.27),'skin','head')
 for side in [-1,1]:m.part(('L'if side>0 else'R')+'_Ear',head,(side*.30,0,-.005),(.055,.077,.052),'skin','small')
 m.part('RoundNose',head,(0,.015,.267),(.048,.052,.058),'skin','small');m.part('Smile',head,(0,-.125,.249),(.85,.85,.85),'hair','smile')
 brows=[]
 for side in [-1,1]:
  pre='L'if side>0 else'R';eye=m.node(pre+'_Eye',head,(side*.115,.10,.247),quat());m.part(pre+'_EyeWhite',eye,(0,0,0),(.052,.061,.030),'white','small');m.part(pre+'_Pupil',eye,(0,0,.029),(.026,.034,.014),'ink','small');m.part(pre+'_Glint',eye,(-.008,.013,.042),(.009,.011,.004),'white','small')
  brow=m.node(pre+'_BrowPivot',head,(side*.12,.205,.238),quat(0,0,side*-.08));m.part(pre+'_Brow',brow,(0,0,0),(.064,.014,.016),'hair','box');brows.append((brow,side))
 m.part('HairCap',head,(0,.17,-.035),(.315,.18,.27),'hair','cap');m.part('HairBack',head,(0,.04,-.245),(.265,.13,.035),'hair','box')
 for side in [-1,1]:m.part('Sideburn_'+str(side),head,(side*.285,.045,-.015),(.033,.07,.07),'hair','box');m.part('Fringe_'+str(side),head,(side*.075,.19,.233),(.092,.039,.035),'hair','box',quat(0,0,side*-.12))
 hat=m.node('Panama',head,(0,.27,0),quat());m.part('PanamaShell',hat,(0,0,0),(.41,.16,.36),'hat','panama');m.part('PanamaBand',hat,(0,0,0),(.412,.16,.362),'ink','hat_band')
 arms={};legs={}
 for side in [-1,1]:
  pre='L'if side>0 else'R';shoulder=m.node(pre+'_Shoulder',torso,(side*.29,.28,0),quat(0,0,side*.22));m.part(pre+'_Sleeve',shoulder,(0,-.075,0),(.082,.105,.087),'shirt','limb');m.part(pre+'_Forearm',shoulder,(0,-.225,0),(.058,.12,.058),'skin','limb');wrist=m.node(pre+'_Wrist',shoulder,(0,-.32,0),quat());m.part(pre+'_Hand',wrist,(0,-.045,.012),(.066,.075,.050),'skin','small');arms[side]=(shoulder,wrist)
  leg=m.node(pre+'_Hip',hips,(side*.14,0,0),quat());m.part(pre+'_Shorts',leg,(0,.005,0),(.108,.145,.115),'sand','limb');m.part(pre+'_Shin',leg,(0,-.22,0),(.065,.19,.065),'skin','limb');ankle=m.node(pre+'_Ankle',leg,(0,-.40,0),quat());m.part(pre+'_Shoe',ankle,(0,-.072,.035),(.105,.075,.15),'white','boot');m.part(pre+'_Sole',ankle,(0,-.139,.035),(.105,.011,.148),'ink','box')
  for z in [.025,.075]:m.part(pre+'_Lace_'+str(z),ankle,(0,-.014,z),(.065,.004,.008),'hat','box')
  legs[side]=(leg,ankle)
 m.part('Waistband',hips,(0,.09,0),(.245,.06,.13),'sand','box')
 pack=m.node('Backpack',torso,(0,.08,-.30),quat());m.part('BackpackBody',pack,(0,0,0),(.215,.255,.09),'bag','shirt');m.part('BackpackPocket',pack,(0,-.07,-.095),(.15,.095,.025),'sand','box');m.part('BackpackZip',pack,(0,.019,-.124),(.13,.005,.005),'ink','box');m.part('BackpackHandle',pack,(0,.27,0),(.067,.016,.018),'ink','box')
 for side in [-1,1]:m.part('FrontStrap_'+str(side),torso,(side*.16,.12,.202),(.018,.22,.009),'ink','box');m.part('ShoulderStrap_'+str(side),torso,(side*.16,.355,-.035),(.018,.012,.23),'ink','box')
 camera=m.node('Camera',torso,(0,.05,.235),quat());m.part('CameraBody',camera,(0,0,0),(.105,.065,.035),'ink','box');m.part('CameraLens',camera,(0,-.005,.053),(.041,.030,.041),'ink','cylinder',quat(P/2));m.part('CameraGlass',camera,(0,-.005,.085),(.032,.003,.032),'lens','cylinder',quat(P/2));m.part('CameraShutter',camera,(.065,.072,0),(.015,.008,.012),'white','box')
 for side in [-1,1]:m.part('CameraStrap_'+str(side),torso,(side*.055,.235,.224),(.009,.115,.006),'ink','box',quat(0,0,side*.12))
 nodes=m.g['nodes'];parents={c:i for i,n in enumerate(nodes)for c in n.get('children',[])};vertices={}
 for i,n in enumerate(nodes):
  if'mesh'not in n:continue
  a=m.g['accessors'][m.g['meshes'][n['mesh']]['primitives'][0]['attributes']['POSITION']];v=m.g['bufferViews'][a['bufferView']];vertices[i]=list(struct.iter_unpack('<fff',m.binary[v['byteOffset']:v['byteOffset']+v['byteLength']]))
 def bounds(pose):
  matrices={}
  def world(i):
   if i in matrices:return matrices[i]
   n=nodes[i];x,y,z,w=pose.get((i,'rotation'),n.get('rotation',[0,0,0,1]));s=n.get('scale',[1,1,1]);t=pose.get((i,'translation'),n.get('translation',[0,0,0]));r=[[1-2*y*y-2*z*z,2*x*y-2*z*w,2*x*z+2*y*w],[2*x*y+2*z*w,1-2*x*x-2*z*z,2*y*z-2*x*w],[2*x*z-2*y*w,2*y*z+2*x*w,1-2*x*x-2*y*y]];local=[[r[a][b]*s[b]for b in range(3)]+[t[a]]for a in range(3)]
   if i in parents:
    a=world(parents[i]);local=[[sum(a[row][k]*local[k][col]for k in range(3))for col in range(3)]+[a[row][3]+sum(a[row][k]*local[k][3]for k in range(3))]for row in range(3)]
   matrices[i]=local;return local
  lo=[math.inf]*3;hi=[-math.inf]*3
  for i,vs in vertices.items():
   a=world(i)
   for v in vs:
    for k in range(3):
     q=a[k][0]*v[0]+a[k][1]*v[1]+a[k][2]*v[2]+a[k][3];lo[k]=min(lo[k],q);hi[k]=max(hi[k],q)
  return lo,hi
 nodes[hips]['translation'][1]-=bounds({})[0][1]
 animated=[pivot,hips,torso,head,*[j for pair in arms.values()for j in pair],*[j for pair in legs.values()for j in pair],*[i for i,_ in brows]]
 neutral={(i,path):nodes[i].get(path,[0,0,0]if path=='translation'else[0,0,0,1])for i in animated for path in ['translation','rotation']};clips={}
 def sample(t,keys):
  for i in range(1,len(keys)):
   if t<=keys[i][0]:u=(t-keys[i-1][0])/(keys[i][0]-keys[i-1][0]);u=u*u*(3-2*u);return keys[i-1][1]*(1-u)+keys[i][1]*u
  return keys[-1][1]
 def export(name,duration,loop,fn,count):
  times=[duration*i/count for i in range(count+1)];poses=[];lo=[math.inf]*3;hi=[-math.inf]*3
  for t in times:
   p={k:list(v)for k,v in neutral.items()};lift=fn(t,p);p[pivot,'translation'][1]+=-bounds(p)[0][1]+lift;low,high=bounds(p)
   lo=[min(lo[i],low[i])for i in range(3)];hi=[max(hi[i],high[i])for i in range(3)];poses.append(p)
  m.animation(name,[(i,path,times,[p[i,path]for p in poses])for i,path in neutral]);clips[name]={'duration':duration,'loop':loop,'bounds_m':{'min':lo,'max':hi}}
 def idle(t,p):
  phase=t/3.2*2*P;p[torso,'translation'][1]+=.006*(1-math.cos(phase))/2;p[head,'rotation']=quat(0,.035*math.sin(phase),.018*math.sin(phase));return 0
 def gait(t,p,duration,run):
  phase=2*P*t/duration;stride=.115 if run else .065;lift=.075 if run else .04;p[torso,'rotation']=quat(.10 if run else .025,.035*math.sin(phase),.045*math.sin(phase));p[head,'rotation']=quat(-.06 if run else 0,-.025*math.sin(phase),-.02*math.sin(phase))
  for side,(leg,ankle)in legs.items():
   a=phase+(0 if side>0 else P);angle=math.asin(stride*math.cos(a)/.40);p[leg,'rotation']=quat(angle);p[ankle,'rotation']=quat(-angle);p[ankle,'translation'][1]+=(lift*max(0,math.sin(a)));p[arms[side][0],'rotation']=quat(-(.52 if run else .30)*math.sin(a),0,side*(.26 if run else .22))
  return 0
 def wave(t,p):
  e=math.sin(P*t/2.2)**.7;p[arms[1][0],'rotation']=quat(0,0,.22+e*(1.9+.18*math.sin(t*15)));p[arms[1][1],'rotation']=quat(0,0,.20*e*math.sin(t*15));p[head,'rotation']=quat(0,0,-.10*e);return 0
 def angry(t,p):
  e=math.sin(P*t/1.8);p[head,'rotation']=quat(.08*e,0,.035*e*math.sin(t*18))
  for i,side in brows:p[i,'rotation']=quat(0,0,side*(-.08+.5*e))
  for side,(shoulder,wrist)in arms.items():p[shoulder,'rotation']=quat(-.35*e,0,side*(.22+.45*e));p[wrist,'rotation']=quat(0,side*.2*e*math.sin(t*18),0)
  p[legs[-1][1],'translation'][1]+=.045*e*max(0,math.sin(t*18));return 0
 def jump(t,p):
  crouch=sample(t,[(0,0),(.20,1),(.35,0),(.70,.55),(.95,.7),(1.2,0)]);p[hips,'translation'][1]-=.045*crouch;p[torso,'rotation']=quat(.10*crouch)
  for side,(leg,ankle)in legs.items():p[ankle,'translation'][1]+=.045*crouch;p[arms[side][0],'rotation']=quat(-.25*crouch,0,side*(.22+.4*math.sin(P*t/1.2)))
  return sample(t,[(0,0),(.30,0),(.6,.44),(.98,0),(1.05,.015),(1.2,0)])
 def fall(t,p):
  angle=sample(t,list(zip([0,.35,.6,.95,1.12,1.3,1.5,1.8,2.1,2.3,2.55,2.8,3.05,3.25,3.45,3.6],[0,.10,-.25,-1.2,-P/2,-1.40,-P/2,-P/2,-1.45,-1.65,-1.25,-.65,-.1,.08,0,0])));p[pivot,'rotation']=quat(angle);p[pivot,'translation'][2]=sample(t,[(0,0),(.6,-.05),(1.12,-.48),(2.3,-.48),(2.8,-.25),(3.25,0),(3.6,0)]);e=sample(t,[(0,0),(.6,.6),(1.1,1),(1.8,.7),(2.3,1),(2.8,.7),(3.45,0),(3.6,0)])
  for side,(leg,ankle)in legs.items():p[leg,'rotation']=quat(-.65*e);p[ankle,'rotation']=quat(.35*e);p[arms[side][0],'rotation']=quat(-.5*e,0,side*(.22+.6*e))
  return sample(t,[(0,0),(1.12,0),(1.3,.055),(1.5,0),(2.3,0),(2.65,.44),(2.95,.30),(3.25,0),(3.35,.02),(3.6,0)])
 export('Idle',3.2,True,idle,48);export('Walk',1,True,lambda t,p:gait(t,p,1,False),64);export('Run',.65,True,lambda t,p:gait(t,p,.65,True),64);export('Wave',2.2,False,wave,64);export('Angry',1.8,False,angry,64);export('Jump',1.2,False,jump,96);export('FallBack',3.6,False,fall,240)
 info=m.save();lo,hi=bounds({});info.update(units='meters',up='+Y',forward='+Z',origin='between feet at ground',root_motion=False,rig='rigid articulated nodes; no skinning',eye_height_m=nodes[hips]['translation'][1]+.40+.65+.10,height_m=hi[1]-lo[1],bounds_m={'min':lo,'max':hi},clips=clips,sha256=hashlib.sha256((OUT/'comical_tourist.glb').read_bytes()).hexdigest());(OUT/'manifest.json').write_text(json.dumps(info,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(json.dumps({k:v for k,v in info.items()if k!='clips'}))
if __name__=='__main__':build()