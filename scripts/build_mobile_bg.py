"""
生成 1920x1080 手机竖屏演示段背景底板与圆角遮罩（用于将 iPhone 16 Pro Max 440x956 真实录屏优雅嵌入 16:9 成品视频前半段）
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "app" / "logo.png"
OUT_BG = Path("/tmp/mobile_stage_bg.png")
OUT_MASK = Path("/tmp/mobile_screen_mask.png")

FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
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


def main():
    W, H = 1920, 1080
    img = Image.new("RGB", (W, H), "#FAF5EE")
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.ellipse((-200, -240, 760, 720), fill=(217, 78, 40, 26))
    od.ellipse((1180, 540, 2120, 1380), fill=(22, 119, 255, 22))
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(img)

    f_badge = load_font(26, 2)
    f_title = load_font(86, 2)
    f_sub = load_font(34, 1)
    f_item = load_font(28, 2)
    f_desc = load_font(22, 0)
    f_foot = load_font(22, 0)

    # 左侧品牌与手机竖屏演示导读
    draw.rounded_rectangle((110, 96, 560, 148), radius=26, fill="#FFF0EA", outline="#F3CBB9", width=2)
    draw.text((138, 108), "Part 1 · 手机端竖屏实测演示", font=f_badge, fill="#D94E28")

    if LOGO.exists():
        logo = Image.open(LOGO).convert("RGBA").resize((112, 112), Image.Resampling.LANCZOS)
        mask = Image.new("L", (112, 112), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, 112, 112), radius=26, fill=255)
        img.paste(logo, (110, 184), mask)

    draw.text((246, 192), "今天吃这桌", font=f_title, fill="#1E1B18")
    draw.text((110, 326), "iPhone 16 Pro Max 竖屏适配 · 单手 30 秒搞定聚餐决策", font=f_sub, fill="#4E463F")

    items = [
        ("01 底部抽屉选单", "统一自定义弹窗，手机拇指轻松单手切换地点与人数"),
        ("02 品质正餐筛选", "自动过滤咖啡甜品，按目标预算档位挑出体面正餐馆"),
        ("03 逐店实时呈现", "拿到一家立刻展示一家，配菜与预算（不含酒水）一目了然"),
        ("04 一键发群定店", "拉起支付宝查团购、导出日历、生成简洁群约饭通知"),
    ]
    y = 422
    for idx, (head, desc) in enumerate(items):
        draw.rounded_rectangle((110, y, 1056, y + 112), radius=20, fill="#FFFFFF", outline="#ECE2D5", width=2)
        bg_chip = "#FFF0EA" if idx != 2 else "#EDF5FF"
        fg_chip = "#D94E28" if idx != 2 else "#1677FF"
        draw.rounded_rectangle((134, y + 26, 396, y + 86), radius=14, fill=bg_chip)
        draw.text((156, y + 38), head, font=f_item, fill=fg_chip)
        draw.text((420, y + 40), desc, font=f_desc, fill="#5C544C")
        y += 130

    draw.text((110, 976), "接下来将自动切换至电脑端横屏全流程实操演示（团购比价精算 + 约饭通知）", font=f_foot, fill="#7D746A")

    # 右侧 iPhone 16 Pro Max 精致手机外框（屏幕槽位：x=1220, y=56, w=446, h=968）
    sx, sy, sw, sh = 1220, 56, 446, 968
    pad = 16
    # 柔和阴影
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((sx - pad + 10, sy - pad + 16, sx + sw + pad + 10, sy + sh + pad + 16), radius=58, fill=(30, 22, 14, 52))
    img = Image.alpha_composite(img.convert("RGBA"), shadow).convert("RGB")
    draw = ImageDraw.Draw(img)

    # 钛金属深色机身边框
    draw.rounded_rectangle((sx - pad, sy - pad, sx + sw + pad, sy + sh + pad), radius=54, fill="#1E1D1B", outline="#524E49", width=3)
    # 内屏底色
    draw.rounded_rectangle((sx, sy, sx + sw, sy + sh), radius=42, fill="#FAF6F0")

    img.save(OUT_BG, "PNG")

    # 生成 446x968 圆角透明遮罩（用于 ffmpeg alphamerge，让视频画面完美贴合手机圆角屏幕）
    m = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, sw - 1, sh - 1), radius=40, fill=255)
    m.save(OUT_MASK, "PNG")
    print(f"BG_DONE: {OUT_BG} | MASK_DONE: {OUT_MASK} | screen=({sx},{sy},{sw},{sh})")


if __name__ == "__main__":
    main()
