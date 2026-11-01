"""Reproducible low-poly market goods. Python 3 standard library only."""
from pathlib import Path
import math,struct,json,hashlib
OUT=Path(__file__).resolve().parent
P=math.pi
COLORS={'cream':(.86,.78,.58),'white':(.96,.94,.83),'teal':(.025,.36,.34),'blue':(.08,.31,.50),'orange':(.95,.27,.025),'red':(.85,.08,.025),'gold':(.93,.58,.08),'yellow':(.98,.72,.045),'brown':(.35,.14,.055),'paper':(.64,.36,.14),'green':(.13,.38,.07),'leaf':(.24,.49,.09),'dark':(.045,.065,.075),'rice':(.99,.96,.82),'broth':(.32,.16,.04)}
WORDS=[
 ('teapot','tableware','茶壶','cháhú','Чайник','word_teapot'),('cup','tableware','茶杯','chábēi','Чайная чашка','word_cup'),('bowl','tableware','碗','wǎn','Миска','word_bowl'),('chopsticks','tableware','筷子','kuàizi','Палочки для еды','word_chopsticks'),('spoon','tableware','勺子','sháozi','Ложка','word_spoon'),
 ('tea','food','茶叶','cháyè','Чайные листья','word_tea'),('rice','food','米饭','mǐfàn','Варёный рис','word_rice'),('noodles','food','面条','miàntiáo','Лапша','word_noodles'),('baozi','food','包子','bāozi','Баоцзы — булочка с начинкой','word_baozi'),('egg','food','鸡蛋','jīdàn','Куриное яйцо','word_egg'),('apple','food','苹果','píngguǒ','Яблоко','word_apple'),('banana','food','香蕉','xiāngjiāo','Банан','word_banana'),('cucumber','food','黄瓜','huángguā','Огурец','word_cucumber'),('tomato','food','西红柿','xīhóngshì','Помидор','word_tomato'),('carrot','food','胡萝卜','húluóbo','Морковь','word_carrot'),
 ('bottle','everyday','瓶子','píngzi','Бутылка','word_bottle'),('umbrella','everyday','雨伞','yǔsǎn','Зонт','word_umbrella'),('backpack','everyday','书包','shūbāo','Рюкзак','word_backpack'),('hat','everyday','帽子','màozi','Шляпа','word_hat'),('shoes','everyday','鞋子','xiézi','Обувь — пара туфель','word_shoes')]
def cross(a,b):return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
def sub(a,b):return [a[i]-b[i]for i in range(3)]
def unit(a):
 l=math.sqrt(sum(x*x for x in a));return [x/l for x in a]
def rotate(v,r):
 x,y,z=v
 for axis,a in enumerate(r):
  c,s=math.cos(a),math.sin(a)
  if axis==0:y,z=y*c-z*s,y*s+z*c
  elif axis==1:x,z=x*c+z*s,-x*s+z*c
  else:x,y=x*c-y*s,x*s+y*c
 return [x,y,z]
def lathe(profile,n=10):
 v=[(r*math.cos(2*P*i/n),y,r*math.sin(2*P*i/n))for y,r in profile for i in range(n)];f=[]
 for j in range(len(profile)-1):
  for i in range(n):
   a=j*n+i;b=j*n+(i+1)%n;c=a+n;d=b+n;f.extend([(a,c,d),(a,d,b)])
 return v,f

def ellipsoid(n=8,rings=4):return lathe([(-math.cos(P*j/rings),math.sin(P*j/rings))for j in range(rings+1)],n)
def box():
 v=[(x,y,z)for x in [-1,1]for y in [-1,1]for z in [-1,1]];f=[]
 for a,b,c,d in [(0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)]:f.extend([(a,b,c),(a,c,d)])
 return v,f

def tube(path,radii,n=6,closed=False):
 v=[];f=[]
 for i,p in enumerate(path):
  tangent=unit(sub(path[(i+1)%len(path)]if closed else path[min(i+1,len(path)-1)],path[(i-1)%len(path)]if closed else path[max(0,i-1)]));ref=[0,1,0]if abs(tangent[1])<.9 else[1,0,0];a=unit(cross(ref,tangent));b=cross(tangent,a)
  for k in range(n):v.append(tuple(p[j]+radii[i]*(a[j]*math.cos(2*P*k/n)+b[j]*math.sin(2*P*k/n))for j in range(3)))
 for i in range(len(path)if closed else len(path)-1):
  for k in range(n):
   a=i*n+k;b=i*n+(k+1)%n;c=((i+1)%len(path))*n+k;d=((i+1)%len(path))*n+(k+1)%n;f.extend([(a,b,d),(a,d,c)])
 if not closed:
  for ring,reverse in [(0,True),((len(path)-1)*n,False)]:
   center=len(v);v.append(tuple(path[0 if reverse else -1]))
   for k in range(n):f.append((center,ring+(k+1)%n,ring+k)if reverse else(center,ring+k,ring+(k+1)%n))
 return v,f

def leaf():return [(0,0,-1),(-.5,0,0),(0,.22,.1),(.5,0,0),(0,0,1),(0,-.12,0)],[(0,1,2),(1,4,2),(4,3,2),(3,0,2),(0,5,1),(1,5,4),(4,5,3),(3,5,0)]

class Goods:
 def __init__(self,name):self.name=name;self.parts={}
 def add(self,shape,color,pos=(0,0,0),scale=(1,1,1),rot=(0,0,0)):
  v,f=shape;v=[[a+b for a,b in zip(rotate([p[i]*scale[i]for i in range(3)],rot),pos)]for p in v];out=self.parts.setdefault(color,[])
  for face in f:
   a,b,c=[v[i]for i in face];n=cross(sub(b,a),sub(c,a))
   if sum(x*x for x in n)>1e-20:out.append((a,b,c,unit(n)))
 def lathe(self,profile,color,n=10,**kw):self.add(lathe(profile,n),color,**kw)
 def ball(self,pos,scale,color,n=8,rings=4):self.add(ellipsoid(n,rings),color,pos,scale)
 def cube(self,pos,scale,color,rot=(0,0,0)):self.add(box(),color,pos,scale,rot)
 def pipe(self,path,radius,color,n=6,closed=False):self.add(tube(path,[radius]*len(path)if isinstance(radius,(float,int))else radius,n,closed),color)
 def save(self):
  points=[p for tris in self.parts.values()for a,b,c,_ in tris for p in [a,b,c]];lo=[min(p[i]for p in points)for i in range(3)];hi=[max(p[i]for p in points)for i in range(3)];offset=[(lo[0]+hi[0])/2,lo[1],(lo[2]+hi[2])/2];dimensions=[hi[i]-lo[i]for i in range(3)]
  binary=bytearray();g={'asset':{'version':'2.0','generator':'Market Goods procedural 1.0'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'name':self.name,'mesh':0}],'meshes':[{'name':self.name,'primitives':[]}],'materials':[],'accessors':[],'bufferViews':[]}
  def acc(data,bounds=False):
   while len(binary)%4:binary.append(0)
   start=len(binary);binary.extend(struct.pack('<'+'f'*len(data)*3,*[x for row in data for x in row]));vi=len(g['bufferViews']);g['bufferViews'].append({'buffer':0,'byteOffset':start,'byteLength':len(binary)-start,'target':34962});a={'bufferView':vi,'componentType':5126,'count':len(data),'type':'VEC3'}
   if bounds:a.update(min=[min(p[i]for p in data)for i in range(3)],max=[max(p[i]for p in data)for i in range(3)])
   i=len(g['accessors']);g['accessors'].append(a);return i
  count=0
  for color,tris in self.parts.items():
   positions=[];normals=[]
   for a,b,c,n in tris:
    positions.extend([[v[i]-offset[i]for i in range(3)]for v in [a,b,c]]);normals.extend([n,n,n])
   pi=acc(positions,True);ni=acc(normals);mi=len(g['materials']);g['materials'].append({'name':color,'pbrMetallicRoughness':{'baseColorFactor':[*COLORS[color],1],'metallicFactor':0,'roughnessFactor':.83}});g['meshes'][0]['primitives'].append({'attributes':{'POSITION':pi,'NORMAL':ni},'material':mi});count+=len(tris)
  assert count<=800,(self.name,count);assert len(g['materials'])<=4
  g['buffers']=[{'byteLength':len(binary)}];data=json.dumps(g,separators=(',',':')).encode();data+=b' '*((-len(data))%4);binary+=b'\0'*((-len(binary))%4);blob=struct.pack('<III',0x46546c67,2,28+len(data)+len(binary))+struct.pack('<II',len(data),0x4e4f534a)+data+struct.pack('<II',len(binary),0x004e4942)+binary;(OUT/(self.name+'.glb')).write_bytes(blob)
  return {'file':self.name+'.glb','triangles':count,'materials':len(g['materials']),'bytes':len(blob),'dimensions_m':dict(zip(['x','y','z'],dimensions)),'bounds_m':{'min':[-dimensions[0]/2,0,-dimensions[2]/2],'max':[dimensions[0]/2,dimensions[1],dimensions[2]/2]},'sha256':hashlib.sha256(blob).hexdigest()}

def vessel(g,color='teal',r=.10,h=.085,n=10):
 g.lathe([(0,0),(0,r*.40),(.006,r*.48),(h*.88,r),(h,r),(h,r*.90),(h*.25,r*.35),(h*.23,0)],color,n)
def plate(g):g.lathe([(0,0),(0,.065),(.005,.095),(.015,.12),(.021,.12),(.021,.105),(.009,.075),(.009,0)],'teal',12)
def make(id):
 g=Goods(id)
 if id=='teapot':
  g.lathe([(0,0),(0,.04),(.016,.07),(.075,.08),(.12,.055),(.125,0)],'teal',10);g.lathe([(.119,0),(.119,.052),(.13,.06),(.145,.015),(.145,0)],'cream',10);g.ball((0,.152,0),(.015,.012,.015),'gold',6,3)
  g.pipe([(.05,.055,0),(.105,.07,0),(.14,.12,0)],[.025,.019,.013],'teal');g.pipe([(.14,.12,0),(.143,.124,0)],.012,'dark')
  g.pipe([(-.065+.046*math.cos(2*P*i/10),.075+.052*math.sin(2*P*i/10),0)for i in range(10)],.012,'cream',4,True)
 elif id=='cup':
  vessel(g,'cream',.043,.055,10);g.pipe([(.045+.022*math.cos(2*P*i/8),.031+.023*math.sin(2*P*i/8),0)for i in range(8)],.006,'teal',4,True);g.lathe([(.048,.0435),(.0553,.0435),(.0553,.0383),(.048,.0383)],'teal',10)
 elif id=='bowl':vessel(g,'teal')
 elif id=='chopsticks':
  for side in [-1,1]:
   g.pipe([(side*.014,.006,-.12),(side*.018,.006,.04),(side*.019,.006,.12)],[.0045,.004,.0025],'brown')
   g.pipe([(side*.0145,.006,-.106),(side*.0146,.006,-.095)],.0048,'gold')
 elif id=='spoon':
  g.lathe([(0,0),(0,.01),(.005,.018),(.012,.020),(.013,.019),(.006,.01),(.006,0)],'cream',10,scale=(1,1,1.5),pos=(0,0,.054));g.cube((0,.006,-.023),(.007,.004,.058),'brown');g.ball((0,.006,-.08),(.009,.004,.012),'brown',6,3)
 elif id=='tea':
  g.cube((0,.004,0),(.061,.004,.041),'paper');g.cube((0,.035,-.04),(.061,.035,.003),'paper');g.cube((0,.035,.04),(.061,.035,.003),'paper')
  for x in [-.06,.06]:g.cube((x,.035,0),(.003,.035,.04),'paper')
  g.cube((0,.094,-.047),(.061,.026,.003),'cream',(-.3,0,0))
  for i in range(12):
   a=i*2.4;g.add(leaf(),'green'if i%2 else'leaf',(.035*math.cos(a),.073+(i%3)*.003,.025*math.sin(a)),(.016,.012,.027),(.1,a,.15))
 elif id=='rice':
  plate(g)
  for layer,count,radius,y in [(0,9,.043,.021),(1,7,.027,.035),(2,5,.013,.049)]:
   for i in range(count):
    a=2*P*i/count+layer*.85;x=radius*math.cos(a);z=radius*math.sin(a)
    g.add(ellipsoid(6,3),'rice'if (i+layer)%3 else 'white',(x,y,z),(.025,.009,.008),(0,a+.7,0))
 elif id=='noodles':
  vessel(g,'teal',.105,.08,10);g.lathe([(.058,0),(.058,.083),(.06,.083),(.06,0)],'broth',10)
  for k in range(7):
   path=[]
   for j in range(7):
    a=(j/6)*P*1.65+k*.9;rad=.036+(k%3)*.013;path.append((rad*math.cos(a),.066+.003*k,rad*math.sin(a)))
   g.pipe(path,.0048,'yellow',4)
  for i in range(3):g.cube(((i-1)*.03,.092,.012),(.008,.004,.013),'green',(0,.3*i,0))
 elif id=='baozi':
  v,f=lathe([(0,0),(0,.035),(.018,.06),(.055,.067),(.085,.048),(.107,.013),(.111,0)],12)
  v=[(x*(.82 if j//12>=4 and j%2 else 1),y,z*(.82 if j//12>=4 and j%2 else 1))for j,(x,y,z)in enumerate(v)];g.add((v,f),'white')
  for i in range(6):
   a=i*P/3;g.pipe([(.044*math.cos(a),.084,.044*math.sin(a)),(.023*math.cos(a),.102,.023*math.sin(a)),(.008*math.cos(a),.111,.008*math.sin(a))],[.002,.002,.001],'cream',3)
 elif id=='egg':g.lathe([(0,0),(.004,.014),(.016,.023),(.035,.022),(.052,.015),(.062,0)],'cream',10)
 elif id=='apple':
  g.lathe([(0,0),(.004,.026),(.02,.044),(.052,.047),(.078,.033),(.072,.009),(.072,0)],'red',10);g.pipe([(0,.073,0),(.003,.094,0)],.004,'brown');g.add(leaf(),'green',(.017,.09,0),(.022,.01,.011),(0,.7,-.35))
 elif id=='banana':
  g.pipe([(-.085,.045,0),(-.06,.020,0),(-.025,.01,0),(.025,.016,0),(.063,.038,0),(.08,.063,0)],[.006,.015,.019,.018,.013,.005],'yellow',6)
  g.pipe([(-.092,.052,0),(-.084,.044,0)],.005,'brown');g.pipe([(.08,.063,0),(.083,.071,0)],.004,'brown')
 elif id=='cucumber':
  g.pipe([(0,.025,-.105),(.006,.025,-.06),(.008,.025,.025),(0,.025,.09),(-.006,.025,.112)],[.009,.024,.026,.02,.005],'green',8)
  for i in range(8):g.ball((.014*math.cos(i*2.4),.044,-.07+.02*i),(.003,.003,.004),'leaf',4,2)
 elif id=='tomato':
  g.lathe([(0,0),(.005,.028),(.022,.05),(.045,.052),(.065,.032),(.061,0)],'red',10)
  for i in range(5):g.add(leaf(),'green',(0,.067,0),(.011,.008,.031),(0,i*2*P/5,0))
  g.pipe([(0,.066,0),(0,.082,.003)],.0035,'green')
 elif id=='carrot':
  g.lathe([(0,0),(.015,.004),(.12,.024),(.165,.031),(.17,0)],'orange',10,pos=(0,.032,.08),rot=(-P/2,0,0))
  for i in range(5):g.add(leaf(),'green'if i%2 else'leaf',((i-2)*.008,.037,-.13),(.018,.014,.06),(0,(i-2)*.25,.25*(i%2)))
 elif id=='bottle':
  g.lathe([(0,0),(0,.031),(.012,.037),(.16,.037),(.19,.017),(.225,.017),(.225,0)],'blue',10);g.lathe([(.218,0),(.218,.019),(.24,.019),(.243,0)],'gold',10);g.lathe([(.06,.0372),(.12,.0372)],'cream',10)
 elif id=='umbrella':
  for i in range(12):
   a=i*2*P/12;b=(i+1)*2*P/12;v=[(0,.96,0),(.31*math.cos(a),.91,.31*math.sin(a)),(.31*math.cos(b),.91,.31*math.sin(b)),(.46*math.cos(a),.81,.46*math.sin(a)),(.46*math.cos(b),.81,.46*math.sin(b))];f=[(0,2,1),(1,2,4),(1,4,3)];g.add((v,f),'red'if i%2 else'gold');g.add(([(x,y-.004,z)for x,y,z in v],[(c,b,a)for a,b,c in f]),'red'if i%2 else'gold');g.pipe([v[3],v[4]],.002,'brown',3)
  g.pipe([(0,.10,0),(0,.97,0)],.006,'dark',8);g.pipe([(0,.12,0),(0,.04,0),(.025,.014,0),(.05,.025,0),(.05,.055,0)],.012,'brown',6)
 elif id=='backpack':
  g.lathe([(0,0),(0,.10),(.04,.15),(.27,.15),(.34,.10),(.35,0)],'red',8,scale=(1,1,.6));g.cube((0,.115,.091),(.10,.069,.025),'paper');g.cube((0,.17,.118),(.09,.004,.003),'gold')
  for x in [-.08,.08]:g.pipe([(x,.29,-.065),(x,.28,-.13),(x,.07,-.13),(x,.05,-.065)],.012,'dark',4)
  g.pipe([(-.045,.325,0),(-.045,.38,0),(.045,.38,0),(.045,.325,0)],.009,'dark',4)
 elif id=='hat':
  g.lathe([(0,0),(0,.24),(.012,.24),(.016,.115),(.105,.11),(.14,.07),(.14,0)],'yellow',12);g.lathe([(.036,.115),(.065,.113)],'brown',12)
 elif id=='shoes':
  for x in [-.07,.07]:
   g.lathe([(0,0),(0,.051),(.014,.059),(.019,.059),(.019,0)],'dark',8,pos=(x,0,0),scale=(1,1,2.1))
   g.lathe([(.017,0),(.017,.05),(.04,.055),(.075,.04),(.08,0)],'brown',8,pos=(x,0,-.012),scale=(1,1,1.9))
   g.ball((x,.082,-.06),(.024,.004,.027),'dark',8,2)
   for z in [-.025,0,.025]:g.cube((x,.083-z*.06,z),(.025,.0025,.003),'cream')
 else:raise ValueError(id)
 return g

def main():
 entries=[]
 for id,category,zh,py,ru,word in WORDS:
  info=make(id).save();info.update(id=id,category=category,word_id=word,zh=zh,py=py,ru=ru)
  if id=='rice':info['note_ru']='Изучаем приготовленный рис в тарелке, не сырое зерно.'
  if id=='tea':info['note_ru']='Изучаем сухие чайные листья в открытой упаковке, не напиток.'
  if id=='noodles':info['note_ru']='Изучаем лапшу; миска служит только для подачи.'
  entries.append(info)
 total=sum(e['triangles']for e in entries);assert total<=8000
 manifest={'version':1,'units':'meters','up':'+Y','forward':'+Z','origin':'center of base','static':True,'total_triangles':total,'categories':{'tableware':'Посуда','food':'Продукты','everyday':'Бытовые вещи'},'lexical_sources':['https://www.mdbg.net/chinese/dictionary?page=cedict','https://cdhk.tongji.edu.cn/_upload/article/files/cc/06/cd5446d74006a36b0e98ec552b3f/0ae245ea-31ce-4bde-accd-2808d96e6f0e.pdf'],'models':entries}
 (OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(json.dumps({'models':len(entries),'triangles':total,'items':[(e['id'],e['triangles'])for e in entries]}))
if __name__=='__main__':main()