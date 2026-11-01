"""Geometry and grounded clips for the round vendor; standard library only."""
import math, struct

def configure(m, quat):
    nodes=m.g['nodes']; ids={n['name']:i for i,n in enumerate(nodes)}
    def node(name):return nodes[ids[name]]
    def change(name,p=None,s=None):
        n=node(name)
        if p is not None:n['translation']=p
        if s is not None:n['scale']=s
    change('Hips',[0,.25,0]);change('Torso',[0,.31,0],[1,1,1])
    change('Coat',[0,.015,.045],[.50,.33,.37]);change('Collar',[0,.315,0],[.12,.045,.12])
    change('GoldSeam',[0,.025,.402],[.012,.27,.012])
    for i in range(4):change('FrogClosure_'+str(i),[0,.23-i*.13,.408],[.09,.01,.014])
    change('Head',[0,.59,.025],[1,1,1]);change('BigHead',s=[.38,.355,.31])
    for side in [-1,1]:
        p='L' if side>0 else 'R'
        change(p+'_Ear',[side*.37,-.04,0],[.068,.09,.065])
        change(p+'_Cheek',[side*.275,-.095,.245],[.165,.15,.13]);node(p+'_Cheek')['mesh']=m.mesh('head','skin')
        m.part(p+'_RosyCheek',ids['Head'],[side*.31,-.065,.365],[.065,.032,.012],'blush','small')
        change(p+'_Shoulder',[side*.51,.22,-.005]);node(p+'_Shoulder')['rotation']=quat(0,0,side*.32)
        change(p+'_Sleeve',[0,-.12,0],[.105,.16,.105]);change(p+'_Wrist',[0,-.30,0])
        change(p+'_Mitten',[0,-.045,.012],[.085,.08,.065])
        change(p+'_Hip',[side*.23,0,0]);change(p+'_ShortLeg',[0,-.075,0],[.105,.10,.10])
        change(p+'_Ankle',[0,-.15,0]);change(p+'_Shoe',[0,-.035,.035],[.12,.06,.15])
    change('MustachePivot',[0,-.09,.385]);change('Smile',[0,-.235,.29])
    change('ConeHat',s=[.76,.32,.72]);change('HatUnderside',s=[.758,.012,.718])
    # Insert an internal action pivot. The asset root never receives animation.
    pivot=m.node('ActionPivot',0,[0,0,0],quat());nodes[0]['children'].remove(ids['Hips']);nodes[pivot]['children']=[ids['Hips']]
    ids['ActionPivot']=pivot
    parents={child:i for i,n in enumerate(nodes) for child in n.get('children',[])}
    vertices={}
    for i,n in enumerate(nodes):
        if 'mesh' not in n:continue
        a=m.g['accessors'][m.g['meshes'][n['mesh']]['primitives'][0]['attributes']['POSITION']];v=m.g['bufferViews'][a['bufferView']]
        vertices[i]=list(struct.iter_unpack('<fff',m.binary[v['byteOffset']:v['byteOffset']+v['byteLength']]))
    def rotate(q,v):
        x,y,z,w=q;vx,vy,vz=v;tx=2*(y*vz-z*vy);ty=2*(z*vx-x*vz);tz=2*(x*vy-y*vx)
        return [vx+w*tx+y*tz-z*ty,vy+w*ty+z*tx-x*tz,vz+w*tz+x*ty-y*tx]
    def minimum(pose):
        low=1e9
        for i,vs in vertices.items():
            chain=[];j=i
            while True:
                chain.append(j)
                if j not in parents:break
                j=parents[j]
            for v in vs:
                for j in chain:
                    n=nodes[j];s=n.get('scale',[1,1,1]);v=rotate(pose.get((j,'rotation'),n.get('rotation',[0,0,0,1])),[v[k]*s[k]for k in range(3)])
                    t=pose.get((j,'translation'),n.get('translation',[0,0,0]));v=[v[k]+t[k]for k in range(3)]
                low=min(low,v[1])
        return low
    node('Hips')['translation'][1]-=minimum({})
    m.g['animations']=[]
    animated=[ids[n]for n in ['Hips','Torso','Head','MustachePivot','L_Shoulder','R_Shoulder','L_Wrist','R_Wrist','L_Hip','R_Hip','L_Ankle','R_Ankle','L_BrowPivot','R_BrowPivot','L_EyePivot','R_EyePivot','Hat','ActionPivot']]
    neutral={(i,path):nodes[i].get(path,[0,0,0]if path=='translation'else[0,0,0,1]) for i in animated for path in ['translation','rotation']}
    def export(name,duration,fn,count):
        times=[duration*i/count for i in range(count+1)];poses=[]
        for t in times:
            p={k:list(v)for k,v in neutral.items()};jump=fn(t,p);p[pivot,'translation'][1]+=-minimum(p)+jump
            poses.append(p)
        m.animation(name,[(i,path,times,[p[i,path]for p in poses])for i,path in neutral])
    def setq(p,name,x=0,y=0,z=0):p[ids[name],'rotation']=quat(x,y,z)
    def idle(t,p):
        setq(p,'Torso',0,.018*math.sin(2*math.pi*t/3.2),.025*math.sin(2*math.pi*t/3.2));setq(p,'Head',0,-.025*math.sin(2*math.pi*t/3.2));return .007*(1-math.cos(2*math.pi*t/3.2))/2
    def wave(t,p):
        env=math.sin(math.pi*t/2.2)**.7;setq(p,'L_Shoulder',0,0,.32+env*(1.85+.18*math.sin(t*15)));setq(p,'L_Wrist',0,0,.20*env*math.sin(t*15));setq(p,'Head',0,0,-.10*env);return 0
    def angry(t,p):
        env=math.sin(math.pi*t/1.8);setq(p,'Head',.10*env,0,.04*env*math.sin(t*20))
        for side in [-1,1]:
            pre='L'if side>0 else'R';setq(p,pre+'_BrowPivot',0,0,side*(-.16+.60*env));setq(p,pre+'_Shoulder',-.4*env,0,side*(.32+.42*env));setq(p,pre+'_Hip',-.32*env*max(0,math.sin(t*18)))
        return .025*env*abs(math.sin(t*18))
    def walk(t,p):
        phase=2*math.pi*t;setq(p,'Torso',0,.04*math.sin(phase),.055*math.sin(phase));setq(p,'Head',0,-.025*math.sin(phase),-.025*math.sin(phase))
        for side in [-1,1]:
            pre='L'if side>0 else'R';a=phase+(0 if side>0 else math.pi);lift=max(0,math.sin(a));p[ids[pre+'_Hip'],'translation']=[side*.23,.04*lift,-.065*math.cos(a)];setq(p,pre+'_Hip',.22*math.sin(a));setq(p,pre+'_Ankle',-.22*math.sin(a));setq(p,pre+'_Shoulder',-.28*math.sin(a),0,side*.32)
        return 0
    export('Idle',3.2,idle,32);export('Wave',2.2,wave,44);export('Angry',1.8,angry,48);export('Walk',1,walk,48)
    def sample(t,keys):
        for i in range(1,len(keys)):
            if t<=keys[i][0]:
                u=(t-keys[i-1][0])/(keys[i][0]-keys[i-1][0]);u=u*u*(3-2*u);return keys[i-1][1]*(1-u)+keys[i][1]*u
        return keys[-1][1]
    angles=list(zip([0,.35,.6,.95,1.12,1.3,1.5,1.8,2.1,2.3,2.55,2.8,3.05,3.25,3.45,3.6],[0,.10,-.25,-1.2,-math.pi/2,-1.40,-math.pi/2,-math.pi/2,-1.45,-1.65,-1.25,-.65,-.1,.08,0,0]))
    def fall(t,p):
        angle=sample(t,angles);setq(p,'ActionPivot',angle);setq(p,'Hat',-angle,0,-.035)
        # The hat bounces clear of the face while counter-rotating, then reseats.
        beta=-angle;lift=max(0,.50-.25*math.cos(beta))*min(1,abs(angle)/.4)
        p[ids['Hat'],'translation']=[0,.25+lift*math.cos(beta),lift*math.sin(beta)]
        p[pivot,'translation'][2]=sample(t,[(0,0),(.6,-.05),(1.12,-.48),(2.3,-.48),(2.8,-.25),(3.25,0),(3.6,0)])
        e=sample(t,[(0,0),(.6,.6),(1.1,1),(1.8,.7),(2.3,1),(2.8,.7),(3.45,0),(3.6,0)])
        for side in [-1,1]:
            pre='L'if side>0 else'R';setq(p,pre+'_Shoulder',-.55*e,0,side*(.32+.65*e));setq(p,pre+'_Hip',-.65*e);setq(p,pre+'_Ankle',.35*e)
        return sample(t,[(0,0),(1.12,0),(1.3,.06),(1.5,0),(2.3,0),(2.65,.48),(2.95,.36),(3.25,0),(3.35,.025),(3.6,0)])
    export('FallBack',3.6,fall,240)