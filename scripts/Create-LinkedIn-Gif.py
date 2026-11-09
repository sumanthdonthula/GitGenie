"""Render a repeatable, illustrated product walkthrough using existing brand art.

Run from the repository root: python scripts/Create-LinkedIn-Gif.py
Requires Pillow. No repositories are changed by this demo.
"""
from pathlib import Path
import math
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'linkedin'
OUT.mkdir(parents=True, exist_ok=True)
W = H = 1080
BG = '#17151f'
WHITE = '#f5f0ff'
MUTED = '#aaa1bc'
PURPLE = '#c3a5fa'
GOLD = '#edc477'
GREEN = '#8bd6b2'

def font(size, bold=False):
    return ImageFont.truetype('C:/Windows/Fonts/segoeui' + ('b' if bold else '') + '.ttf', size)

art = Image.open(ROOT / 'artifacts/extension-sync.png').convert('RGB')
# Reuse the actual extension mascot, without regenerating its character design.
mascot = art.crop((75, 260, 605, 785)).resize((318, 315), Image.Resampling.LANCZOS)
scenes = [
    ('Keep coding. Genie keeps watch.', '01 / WORK ON YOUR BRANCH',
     'feature/free-shipping', 'Your branch is 1 commit ahead',
     [('YOU', 'Add free shipping over $50', PURPLE), ('GENIE', 'Fetch remote updates in the background', GREEN)],
     'Background checks leave your working files alone.', 'Watching your branch', GREEN),
    ('A teammate touches the same lines.', '02 / DETECT AN OVERLAP',
     'Incoming from origin/main', 'dev-2 · Update standard shipping fee',
     [('FILE', 'src/checkout.ts', GOLD), ('ALERT', 'Same lines · possible rebase conflict', GOLD)],
     'Genie reveals a new overlap before you integrate.', 'Overlap detected', GOLD),
    ('See what changed. And who.', '03 / REVIEW THE DETAILS',
     'src/checkout.ts', 'Two changes. One shipping calculation.',
     [('YOU', 'Free shipping when subtotal > $50', PURPLE), ('DEV-2', 'Raise the standard fee from $5 to $8', GOLD)],
     'Review Details and the relevant incoming commits.', 'Review the overlap', GOLD),
    ('Ready to sync? You decide.', '04 / COMMIT OR STASH, THEN SYNC',
     'Pull & Rebase', 'onto origin/main · runs only when clicked',
     [('FIRST', 'Save files. Commit or stash your edits.', PURPLE), ('CLICK', 'Fetch base → back up HEAD → rebase', GREEN)],
     'Stay on your feature branch throughout the sync.', 'Pull & Rebase', PURPLE),
    ('If Git pauses, resolve the conflict.', '05 / RESOLVE WHEN NEEDED',
     'Rebase paused', 'Open Source Control in VS Code',
     [('RESOLVE', 'Keep free shipping + the updated fee', GOLD), ('STAGE', 'Stage the resolved file', PURPLE)],
     'Continue Rebase resumes; Abort restores the start.', 'Resolve → stage → continue', GOLD),
    ('Back in sync. Back to building.', '06 / CONTINUE CODING',
     'feature/free-shipping', 'Rebased onto the fetched origin/main',
     [('DONE', 'Your feature includes the latest base', GREEN), ('NEXT', 'Genie keeps watching for new overlaps', PURPLE)],
     'A companion for your workflow. You stay in control.', 'Ready for your next change', GREEN),
    ('Fewer merge surprises.', 'GIT GENIE / YOUR VS CODE COMPANION',
     'Catch overlapping changes early.', 'Pull and rebase when you are ready.',
     [('WATCH', 'Code → detect → review', PURPLE), ('SYNC', 'Commit → rebase → resolve → continue', GREEN)],
     'github.com/sumanthdonthula/GitGenie', 'Rub the lamp. Meet your genie.', GOLD),
]

def render(index, tick):
    title, eyebrow, heading, sub, rows, note, status, accent = scenes[index]
    im = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(im)
    d.text((56, 35), 'git', font=font(44, True), fill=WHITE)
    d.text((109, 35), 'genie', font=font(44), fill=PURPLE)
    d.polygon([(241, 45), (245, 57), (257, 61), (245, 65), (241, 77), (237, 65), (225, 61), (237, 57)], fill=GOLD)
    d.rounded_rectangle((812, 45, 1024, 85), radius=12, outline='#474052', width=2)
    d.text((834, 51), 'WORKFLOW DEMO', font=font(19, True), fill=MUTED)
    d.text((56, 132), eyebrow, font=font(21, True), fill=accent)
    d.text((56, 176), title, font=font(43, True), fill=WHITE)
    # The mascot gently floats while the workflow advances.
    im.paste(mascot, (712, 265 + round(5 * math.sin(tick * math.pi / 9))))
    d.rounded_rectangle((56, 280, 694, 554), radius=22, fill='#211c2e', outline='#3d324f', width=2)
    d.text((84, 305), 'YOUR GENIE', font=font(18, True), fill=PURPLE)
    # Wrap status so it remains readable beside the original mascot.
    words = status.split(); lines = ['']
    for word in words:
        candidate = (lines[-1] + ' ' + word).strip()
        if d.textlength(candidate, font=font(34, True)) > 566:
            lines.append(word)
        else:
            lines[-1] = candidate
    for n, line in enumerate(lines):
        d.text((84, 361 + n * 46), line, font=font(34, True), fill=WHITE)
    d.ellipse((85, 492, 97, 504), fill=accent)
    d.text((110, 482), 'VS Code · Git Genie', font=font(22), fill=MUTED)
    d.rounded_rectangle((56, 587, 1024, 920), radius=22, fill='#201c29', outline='#393241', width=2)
    d.text((84, 613), heading, font=font(32, True), fill=WHITE)
    d.text((84, 663), sub, font=font(25), fill=MUTED)
    for row, (label, value, color) in enumerate(rows):
        y = 734 + row * 76
        d.rounded_rectangle((84, y, 213, y + 43), radius=9, fill='#30283f')
        d.text((99, y + 7), label, font=font(20, True), fill=color)
        d.text((235, y + 3), value, font=font(25), fill=WHITE)
    d.text((56, 944), note, font=font(24), fill=MUTED)
    for step in range(len(scenes)):
        x = 56 + step * 140
        d.rounded_rectangle((x, 1013, x + 126, 1021), radius=4, fill=PURPLE if step < index else '#393142')
        if step == index:
            d.rounded_rectangle((x, 1013, x + max(8, int(126 * (tick + 1) / 24)), 1021), radius=4, fill=accent)
    return im

frames = [render(i, t) for i in range(len(scenes)) for t in range(24)]
frames[24 + 12].save(OUT / 'git-genie-linkedin-preview.png')
palette = Image.new('RGB', (540, 540 * len(scenes)))
for i in range(len(scenes)):
    palette.paste(frames[i * 24].resize((540, 540)), (0, i * 540))
palette = palette.quantize(colors=128)
indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
indexed[0].save(OUT / 'git-genie-lifecycle.gif', save_all=True, append_images=indexed[1:], duration=125, loop=0, optimize=True, disposal=1)
print(OUT / 'git-genie-lifecycle.gif')
print('1080 x 1080 · 21 seconds · 8 fps · looping GIF')
