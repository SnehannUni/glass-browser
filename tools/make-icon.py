# Erzeugt das App-Icon: eine schillernde Farbscheibe (wahlweise in einer Glasschale), vollständig berechnet
# (keine Bildvorlage), damit jede Größe scharf ist. Schreibt assets/icon.png (1024 px)
# und assets/glass.ico (jede Größe einzeln gerendert).
# Aufruf: python tools/make-icon.py
from PIL import Image
import numpy as np, os

RIM=False   # True: Farbfläche in einer Glasschale mit leerem Abstand; False: nur die Farbfläche, so groß wie möglich

def render(OUT, SS=None, rim=RIM):
    SS=SS or max(2, 128//OUT)          # kleine Größen stärker überabtasten
    N=OUT*SS
    yy,xx=(np.mgrid[0:N,0:N]+0.5)/N*2-1          # -1..1
    r=np.hypot(xx,yy); ang=np.arctan2(yy,xx)
    px=2/N; pxo=2/OUT                               # ein Pixel der Überabtastung bzw. des Ergebnisses
    def band(c,w):
        w=max(w,0.7*pxo); return np.clip(1-np.abs(r-c)/w,0,1)   # Linien nie dünner als ~1 Ergebnis-Pixel
    def ramp(a,b): return np.clip((r-a)/(b-a),0,1)

    RF=0.86                                          # Bodenradius (Fuß der Glaswand)
    RC=0.74 if rim else 1.0                          # Radius der Farbfläche; mit Schale bleibt bis zur Wand ein leerer Abstand
    # --- Boden: weich verlaufende Farbinseln ---
    fx,fy=xx/RC,yy/RC
    wx=fx+0.10*np.sin(2.3*fy+0.7)+0.06*np.sin(4.1*fy-1.3)
    wy=fy+0.10*np.sin(2.1*fx-0.4)+0.06*np.sin(3.7*fx+2.0)
    C=dict(cyan=(110,224,240),pink=(255,155,205),yellow=(255,234,145),lav=(196,178,250),blue=(135,185,250),milk=(240,236,250),mint=(150,238,212))
    blobs=[(0.0,-0.68,'cyan'),(-0.45,-0.45,'lav'),(-0.70,-0.08,'pink'),(-0.48,0.33,'yellow'),(0.02,0.0,'milk'),
           (0.58,0.02,'cyan'),(0.32,-0.28,'mint'),(0.40,0.40,'yellow'),(0.42,0.70,'pink'),(-0.05,0.80,'blue'),
           (-0.28,0.60,'pink'),(0.55,-0.52,'lav'),(-0.15,-0.20,'lav'),(0.70,0.30,'mint')]
    num=np.zeros((N,N,3)); den=np.zeros((N,N))
    for bx,by,k in blobs:
        w=np.exp(-((wx-bx)**2+(wy-by)**2)/(2*0.25**2))+1e-6
        num+=w[...,None]*np.array(C[k],float); den+=w
    floor=num/den[...,None]
    rf=r/RC
    # milchiger Schimmer zum Rand hin; ohne Schale schwächer, damit die Scheibe auf hellem Grund nicht verschwimmt
    floor=floor+(np.array([244,244,250.])-floor)*(np.clip((rf-0.86)/0.14,0,1)**1.5*(0.35 if rim else 0.12))[...,None]

    # Ebenen von unten nach oben: (Farbe, Deckkraft)
    rgb=np.zeros((N,N,3)); a=np.zeros((N,N))
    def over(col,t):
        nonlocal rgb,a
        col=np.asarray(col,float); col=col if col.ndim==3 else col[None,None,:]
        t=np.clip(t,0,1)
        na=t+a*(1-t)
        rgb=(col*t[...,None]+rgb*(a*(1-t))[...,None])/np.maximum(na,1e-6)[...,None]
        a=na
    disc=np.clip((1.0-r)/(1.5*px)+0.5,0,1)
    inside=np.clip((RC-r)/(0.012 if rim else 1.5*px)+0.5,0,1)   # mit Schale leicht weiche Kante, sonst scharf
    light=-np.cos(ang+np.pi*0.75)                      # +1 oben links, -1 unten rechts
    hue=(ang/(2*np.pi)*3+0.15)%1
    def rainbow(h,amp=60):
        k=np.array([0,1/3,2/3]); return 185+amp*np.cos(2*np.pi*(h[...,None]-k))
    tint=np.clip(0.5+0.5*np.sin(2*ang+0.6),0,1)

    if not rim:
        over(floor,inside)
        out=np.dstack([np.clip(rgb,0,255),a*255]).astype(np.uint8)
        return Image.fromarray(out,'RGBA').resize((OUT,OUT),Image.LANCZOS)

    # Glaswand (nur der Ring außen): klar, leicht bläulich, oben links heller
    wall=disc*np.clip((r-RF)/(1.5*px)+0.5,0,1)
    over((232,238,244),wall*(0.42+0.08*light))
    # Farbfläche
    over(floor,inside)
    over((255,255,255),band(RC+0.004,0.006)*0.5)    # feiner Lichtsaum um die Farbfläche
    # Wandfuß: weiche helle Kante am Boden, dann feine Schattenlinie
    over((255,255,255),band(RF+0.004,0.010)*0.6)
    over((140,165,190),band(RF+0.015,0.004)*0.55)
    over((250,252,255),ramp(RF+0.02,RF+0.035)*(1-ramp(0.905,0.92))*0.35)
    # innere Wandkante: schillernd + dunkle Linie + Glanz
    over(rainbow(hue),band(0.925,0.010)*(0.35+0.5*tint))
    over((105,135,170),band(0.936,0.005)*0.8)
    over((255,255,255),band(0.947,0.005)*0.9)
    # Oberkante der Wand
    over(rainbow(hue+0.33,70),band(0.970,0.013)*(0.25+0.45*(1-tint)))
    over((255,255,255),band(0.986,0.0045)*0.75)
    over((100,130,168),band(0.994,0.0045)*0.9*disc)
    # Glanzlicht oben links
    gl=np.exp(-((ang+2.25)/0.38)**2)*np.clip(1-np.abs(r-0.962)/0.03,0,1)
    over((255,255,255),gl*0.85)
    # Schatten der Wand unten rechts, ganz leicht
    over((90,110,140),np.clip(-light,0,1)*band(0.94,0.05)*0.12)

    out=np.dstack([np.clip(rgb,0,255),a*255]).astype(np.uint8)
    return Image.fromarray(out,'RGBA').resize((OUT,OUT),Image.LANCZOS)

os.chdir(os.path.join(os.path.dirname(__file__), '..', 'assets'))
render(1024).save('icon.png', optimize=True)
sizes=[256,128,64,48,40,32,24,20,16]
frames=[render(s) for s in sizes]
frames[0].save('glass.ico', format='ICO', sizes=[(s,s) for s in sizes], append_images=frames[1:])
