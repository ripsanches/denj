"""Генерирует иконки, заставку и звуки будильника для Android-оболочки."""
import math, os, struct, wave
from PIL import Image, ImageDraw

RES = os.path.join(os.path.dirname(__file__), "..", "android", "app", "src", "main", "res")
GREEN = (31, 107, 92); WHITE = (255, 255, 255); MINT = (92, 196, 174)

def mark(draw, cx, cy, s, width):
    # кольцо прогресса с галочкой — как на главном экране
    r = s * 0.36
    draw.arc([cx - r, cy - r, cx + r, cy + r], 0, 360, fill=(255, 255, 255, 70), width=width)
    draw.arc([cx - r, cy - r, cx + r, cy + r], -90, 200, fill=MINT, width=width)
    pts = [(cx - s * .16, cy + s * .01), (cx - s * .04, cy + s * .13), (cx + s * .18, cy - s * .12)]
    draw.line(pts, fill=WHITE, width=width, joint="curve")

def icon(size, rounded=True, circle=False, fg_only=False):
    sc = 4; S = size * sc
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    if not fg_only:
        if circle: d.ellipse([0, 0, S - 1, S - 1], fill=GREEN)
        else: d.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * .22, fill=GREEN)
        mark(d, S / 2, S / 2, S * .95, int(S * .075))
    else:
        mark(d, S / 2, S / 2, S * .62, int(S * .05))  # безопасная зона адаптивной иконки
    return im.resize((size, size), Image.LANCZOS)

dens = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
for name, k in dens.items():
    d = os.path.join(RES, f"mipmap-{name}")
    icon(int(48 * k)).save(os.path.join(d, "ic_launcher.png"))
    icon(int(48 * k), circle=True).save(os.path.join(d, "ic_launcher_round.png"))
    icon(int(108 * k), fg_only=True).save(os.path.join(d, "ic_launcher_foreground.png"))

with open(os.path.join(RES, "values", "ic_launcher_background.xml"), "w") as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#1F6B5C</color>\n</resources>\n')

# заставки: зелёный фон и знак по центру
for root, _, files in os.walk(RES):
    for fn in files:
        if fn == "splash.png":
            p = os.path.join(root, fn); w, h = Image.open(p).size
            im = Image.new("RGB", (w, h), GREEN); s = min(w, h) * .35
            m = icon(int(s), fg_only=True); im.paste(m, (int((w - s) / 2), int((h - s) / 2)), m); im.save(p)

# звуки: короткие мелодии, повторяются системой при каждом уведомлении
raw = os.path.join(RES, "raw"); os.makedirs(raw, exist_ok=True)
RATE = 22050
def tone_file(name, notes, wave_kind="sine", vol=.5, repeat=2, gap=.35):
    frames = bytearray()
    for _ in range(repeat):
        for freq, dur in notes:
            n = int(RATE * dur)
            for i in range(n):
                t = i / RATE
                env = min(1, i / (RATE * .01)) * math.exp(-3.2 * t / dur)
                v = math.sin(2 * math.pi * freq * t)
                if wave_kind == "square": v = 1 if v > 0 else -1; v *= .45
                v += .3 * math.sin(4 * math.pi * freq * t) if wave_kind == "sine" else 0
                frames += struct.pack("<h", int(max(-1, min(1, v * env * vol)) * 32767))
        frames += b"\x00\x00" * int(RATE * gap)
    with wave.open(os.path.join(raw, name + ".wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(bytes(frames))

tone_file("bell", [(1046, .25), (1318, .25), (1568, .5)], repeat=3)
tone_file("alarm", [(880, .12), (0.0001, .06)] * 4, wave_kind="square", vol=.6, repeat=4, gap=.25)
tone_file("soft", [(523, .35), (659, .35), (784, .35), (659, .6)], vol=.45, repeat=2)
print("ok")
