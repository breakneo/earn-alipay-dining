"""
生成「今天吃这桌」纯中文 16:9 高清参赛封面图（1920x1080，<=5MB）
使用正式品牌图标 app/logo.png + 真实运行界面高清截图
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
SUB = ROOT / "submission"
LOGO = APP / "logo.png"
SCREEN = SUB / "screen_results.png"
OUT = SUB / "cover_16x9.png"

FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]


def load_font(size: int, index: int = 0):
    for fp in FONT_CANDIDATES:
        if Path(fp).exists():
            try:
                return ImageFont.truetype(fp, size=size, index=index)
            except Exception:
                try:
                    return ImageFont.truetype(fp, size=size)
                except Exception:
                    pass
    return ImageFont.load_default()


def draw_rounded_rect(draw, xy, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def main():
    W, H = 1920, 1080
    img = Image.new("RGB", (W, H), "#FAF5EE")

    # 背景柔和暖光装饰圆
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.ellipse((-220, -240, 760, 740), fill=(217, 78, 40, 26))
    od.ellipse((1180, 560, 2120, 1380), fill=(22, 119, 255, 22))
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(img)

    f_badge = load_font(28, 2)
    f_title = load_font(104, 2)
    f_sub = load_font(36, 1)
    f_chip = load_font(25, 2)
    f_desc = load_font(23, 0)
    f_foot = load_font(24, 0)

    # 顶部赛事赛道标识（纯中文）
    draw_rounded_rect(draw, (76, 86, 516, 146), 30, fill="#FFF0EA", outline="#F3C5B4", width=2)
    draw.text((104, 98), "生活好帮手 · 吃好每顿饭", fill="#C8411D", font=f_badge)

    # 正式品牌图标 + 大标题
    if LOGO.exists():
        logo_img = Image.open(LOGO).convert("RGBA").resize((120, 120), Image.Resampling.LANCZOS)
        img.paste(logo_img, (76, 190), logo_img)
    draw = ImageDraw.Draw(img)
    draw.text((222, 192), "今天吃这桌", fill="#1F1D1A", font=f_title)

    # 一句话核心卖点
    draw.text((80, 352), "自选距离与家数挑好饭馆 · 按人数配好一桌菜", fill="#3F3A34", font=f_sub)
    draw.text((80, 410), "支付宝口碑团购比价算差价 · 一键发群约饭通知", fill="#3F3A34", font=f_sub)

    # 4 个能力要点卡片
    points = [
        ("01 附近真店精选", "按距离、口碑、人均与忌口自选 1-10 家真店", "#D94E28", "#FFF0EA"),
        ("02 按人数配好菜", "凉菜、硬菜、时蔬与汤主食精准配比不浪费", "#237A47", "#EBF7EF"),
        ("03 口碑团购比价", "一键问阿宝查团购，贴套餐实算省多少钱", "#1677FF", "#EDF5FF"),
        ("04 约饭定店通知", "一键发群定位、导日历，直达高德精准导航", "#8A5300", "#FFF6E6"),
    ]
    y = 508
    for head, desc, fg, bg in points:
        draw_rounded_rect(draw, (76, y, 836, y + 92), 20, fill="#FFFFFF", outline="#EAE2D7", width=2)
        draw_rounded_rect(draw, (94, y + 18, 326, y + 74), 14, fill=bg)
        draw.text((112, y + 28), head, fill=fg, font=f_chip)
        draw.text((346, y + 30), desc, fill="#524C45", font=f_desc)
        y += 108

    draw.text((80, 986), "高德地图商户数据  ×  支付宝口碑阿宝联动  ×  手机电脑自适应打开即用", fill="#7D756B", font=f_foot)

    # 右侧嵌入真实运行界面高清截图
    if SCREEN.exists():
        shot = Image.open(SCREEN).convert("RGB")
        sw, sh = shot.size
        crop = shot.crop((int(sw * 0.19), 8, int(sw * 0.81), min(sh, 1020)))
        target_w = 970
        target_h = int(crop.height * (target_w / crop.width))
        if target_h > 920:
            target_h = 920
            target_w = int(crop.width * (target_h / crop.height))
        resized = crop.resize((target_w, target_h), Image.Resampling.LANCZOS)

        px = 1852 - target_w
        py = (H - target_h) // 2

        shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        sd.rounded_rectangle((px - 6, py + 12, px + target_w + 6, py + target_h + 18), radius=26, fill=(31, 29, 26, 48))
        shadow = shadow.filter(ImageFilter.GaussianBlur(18))
        img = Image.alpha_composite(img.convert("RGBA"), shadow).convert("RGB")

        mask = Image.new("L", (target_w, target_h), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, target_w, target_h), radius=22, fill=255)
        img.paste(resized, (px, py), mask)

        draw = ImageDraw.Draw(img)
        draw.rounded_rectangle((px, py, px + target_w, py + target_h), radius=22, outline="#E2D8CC", width=3)

    img.save(OUT, "PNG", optimize=True)
    size_kb = OUT.stat().st_size / 1024
    print(f"COVER_DONE: {OUT} ({W}x{H}, {size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
