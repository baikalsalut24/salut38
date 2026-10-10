#!/usr/bin/env python3
# Картинка дисконтной карты для бота: python3 cardimg.py 38-123456 out.png
import sys, os, math, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter
HERE = os.path.dirname(os.path.abspath(__file__)); A = os.path.join(HERE, 'assets')
code, out = sys.argv[1], sys.argv[2]
S = 2; W, H = 1200 * S, 720 * S
F = lambda n, sz: ImageFont.truetype(os.path.join(A, 'fonts', 'Montserrat-' + n + '.ttf'), sz * S)
img = Image.new('RGB', (W, H), '#0b1022')
# фон: диагональный градиент
g = Image.new('RGB', (W, H)); gp = g.load()
c1, c2 = (34, 46, 92), (8, 12, 26)
for y in range(0, H, 2):
    for x in range(0, W, 8):
        t = min(1, max(0, (x / W) * .55 + (y / H) * .45))
        col = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
        for dx in range(8):
            if x + dx < W: gp[x + dx, y] = col; gp[x + dx, min(H - 1, y + 1)] = col
img.paste(g)
# золотой круг и салют
glow = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(glow)
for k in range(14):
    rr = (360 - k * 22) * S; d.ellipse((W - 230 * S - rr, 160 * S - rr, W - 230 * S + rr, 160 * S + rr), fill=(255, 190, 60, 7))
rnd = random.Random(int(''.join(ch for ch in code if ch.isdigit()) or 7))
for (cx, cy, r, col) in [(W - 230 * S, 160 * S, 120 * S, (255, 210, 31)), (W - 400 * S, 90 * S, 60 * S, (255, 140, 190)), (W - 120 * S, 300 * S, 55 * S, (120, 200, 255))]:
    for k in range(34):
        a = 2 * math.pi * k / 34 + rnd.uniform(-.05, .05); rr = r * rnd.uniform(.75, 1)
        x1, y1 = cx + math.cos(a) * rr * .3, cy + math.sin(a) * rr * .3; x2, y2 = cx + math.cos(a) * rr, cy + math.sin(a) * rr
        d.line((x1, y1, x2, y2), fill=col + (150,), width=3 * S); d.ellipse((x2 - 4 * S, y2 - 4 * S, x2 + 4 * S, y2 + 4 * S), fill=col + (230,))
glow = glow.filter(ImageFilter.GaussianBlur(1.2 * S))
img = Image.alpha_composite(img.convert('RGBA'), glow)
d = ImageDraw.Draw(img)
# логотип и название
try:
    lg = Image.open(os.path.join(A, 'logo.png')).convert('RGBA').resize((96 * S, 96 * S), Image.LANCZOS); img.alpha_composite(lg, (70 * S, 62 * S))
except Exception: pass
fb = F('Black', 52); d.text((186 * S, 76 * S), 'Байкал', font=fb, fill='white'); w = d.textlength('Байкал ', font=fb); d.text((186 * S + w, 76 * S), 'Салют', font=fb, fill='#FFD21F')
d.text((72 * S, 210 * S), 'ДИСКОНТНАЯ КАРТА', font=F('ExtraBold', 26), fill=(154, 163, 189))
d.text((72 * S, 250 * S), 'Номер карты', font=F('SemiBold', 30), fill=(201, 208, 230))
d.text((66 * S, 290 * S), code, font=F('Black', 128), fill='white')
# лесенка
steps = [(5, 'до 5 т'), (10, '5–20 т'), (15, '20–50 т'), (20, '50–100 т'), (25, '100–500 т'), (30, 'от 500 т')]
bx, by, bw, gap = 72 * S, 650 * S, 92 * S, 12 * S
for i, (v, l) in enumerate(steps):
    h = (54 + i * 22) * S; x = bx + i * (bw + gap)
    d.rounded_rectangle((x, by - h, x + bw, by), radius=12 * S, fill=(255, 210, 31) if i == 5 else (52, 66, 120))
    t = f'{v}%'; f = F('Black', 28); tw = d.textlength(t, font=f); d.text((x + (bw - tw) / 2, by - h + 10 * S), t, font=f, fill='#10162A' if i == 5 else 'white')
    f2 = F('SemiBold', 16); tw = d.textlength(l, font=f2); d.text((x + (bw - tw) / 2, by + 10 * S), l, font=f2, fill=(154, 163, 189))
d.text((740 * S, 472 * S), 'Скидка от 5% до 30%', font=F('Black', 34), fill='#FFD21F')
d.text((740 * S, 522 * S), 'чем больше заказ —', font=F('SemiBold', 30), fill='white')
d.text((740 * S, 560 * S), 'тем больше скидка', font=F('SemiBold', 30), fill='white')
d.text((740 * S, 625 * S), 'salut38.shop', font=F('ExtraBold', 28), fill=(154, 163, 189))
img.convert('RGB').resize((W // S, H // S), Image.LANCZOS).save(out, 'PNG', optimize=True)
