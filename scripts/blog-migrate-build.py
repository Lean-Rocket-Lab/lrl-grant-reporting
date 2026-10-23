#!/usr/bin/env python3
"""Phase 2 of the Wix -> GHL blog migration (docs/sprints/blog-migration.md).

Reads reports/blog-migration/wix-export.json + the YouTube channel feed and writes
reports/blog-migration/plan.json: one entry per GHL post (47 blog posts + 9 podcast episodes)
with clean HTML, slug, original date, categories (labels), tags, cover source and alt text.
Branded covers for posts that have none are rendered to reports/blog-migration/covers/.

Read-only against Wix/GHL. Re-runnable.
    python3 scripts/blog-migrate-build.py
"""
import html, json, os, re, urllib.request, xml.etree.ElementTree as ET
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.getcwd(), 'reports', 'blog-migration')
EXPORT = json.load(open(os.path.join(ROOT, 'wix-export.json')))
CHANNEL = 'UCGFRlBoXi6MdAscjSPX1vuQ'
PODCAST_CAT = 'Podcast'
APPLE_SHOW = 'https://podcasts.apple.com/us/podcast/startup-storytelling-by-lean-rocket-lab/id1838501485'
YT_CHANNEL = 'https://www.youtube.com/@LeanRocketLab'
SKIP_VIDEO_IDS = {'2OpuDTmsj7Q'}  # re-upload of episode 3; MVLF6Z8eh_g is the canonical one

cat_label = {c['id']: c['label'] for c in EXPORT['categories']}
tag_label = {t['id']: t['label'] for t in EXPORT['tags']}
esc = lambda s: html.escape(s or '', quote=True)

def yt_id(url):
    m = re.search(r'(?:youtu\.be/|v=|embed/|shorts/)([A-Za-z0-9_-]{11})', url or '')
    return m.group(1) if m else None

def yt_embed(vid, title):
    return ('<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;margin:0 0 24px">'
            f'<iframe src="https://www.youtube.com/embed/{vid}" title="{esc(title)}" '
            'style="position:absolute;top:0;left:0;width:100%;height:100%;border:0" '
            'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" '
            'allowfullscreen></iframe></div>')

def wix_img(src):
    url = src.get('url') or ''
    if not url and src.get('id'):
        url = 'https://static.wixstatic.com/media/' + src['id']
    return url

def text_html(n):
    td = n['textData']; s = esc(td.get('text', '')).replace('\n', '<br>')
    link = None
    for d in td.get('decorations', []):
        t = d['type']
        if t == 'BOLD' and (d.get('fontWeightValue') in (None, 700) or (d.get('fontWeightValue') or 0) >= 600): s = f'<strong>{s}</strong>'
        elif t == 'ITALIC' and d.get('italicData', True) is not False: s = f'<em>{s}</em>'
        elif t == 'UNDERLINE' and d.get('underlineData', True) is not False: pass  # underline reads as a link on the web; drop it
        elif t == 'LINK': link = (d.get('linkData') or {}).get('link') or {}
    if link and link.get('url'):
        s = f'<a href="{esc(link["url"])}" target="_blank" rel="noopener">{s}</a>'
    return s

def inline(nodes):
    return ''.join(text_html(c) if c['type'] == 'TEXT' else render(c) for c in nodes or [])

def render(n, images=None):
    t = n['type']; kids = n.get('nodes', [])
    if t == 'PARAGRAPH':
        inner = inline(kids)
        return f'<p>{inner}</p>' if re.sub(r'<[^>]+>|\s|&nbsp;', '', inner) else ''
    if t == 'HEADING':
        lvl = max(2, min(4, n.get('headingData', {}).get('level', 2)))
        return f'<h{lvl}>{inline(kids)}</h{lvl}>'
    if t in ('BULLETED_LIST', 'ORDERED_LIST'):
        tag = 'ul' if t == 'BULLETED_LIST' else 'ol'
        return f'<{tag}>' + ''.join(render(c, images) for c in kids) + f'</{tag}>'
    if t == 'LIST_ITEM':
        parts = []
        for c in kids:
            parts.append(inline(c.get('nodes')) if c['type'] == 'PARAGRAPH' else render(c, images))
        return '<li>' + ''.join(parts) + '</li>'
    if t == 'IMAGE':
        d = n['imageData']; url = wix_img(d['image']['src'])
        if images is not None: images.append(url)
        alt = d.get('altText') or ''
        cap = d.get('caption') or ''
        img = f'<img src="{esc(url)}" alt="{esc(alt)}" style="max-width:100%;height:auto">'
        if (d.get('link') or {}).get('url'):
            img = f'<a href="{esc(d["link"]["url"])}" target="_blank" rel="noopener">{img}</a>'
        return f'<figure>{img}' + (f'<figcaption>{esc(cap)}</figcaption>' if cap else '') + '</figure>'
    if t == 'VIDEO':
        d = n['videoData']; url = d['video']['src'].get('url', '')
        vid = yt_id(url)
        return yt_embed(vid, d.get('title') or 'Video') if vid else f'<p><a href="{esc(url)}" target="_blank" rel="noopener">Watch the video</a></p>'
    if t == 'DIVIDER': return '<hr>'
    if t == 'BLOCKQUOTE': return '<blockquote>' + ''.join(render(c, images) for c in kids) + '</blockquote>'
    return ''.join(render(c, images) for c in kids)

def body_html(post, images):
    return '\n'.join(x for x in (render(n, images) for n in (post.get('richContent') or {}).get('nodes', [])) if x)

def words(h):
    return len(re.sub(r'<[^>]+>', ' ', h).split())

def listen_block():
    return ('<h3>Listen and subscribe</h3><p>'
            f'<a href="{APPLE_SHOW}" target="_blank" rel="noopener">Apple Podcasts</a> | '
            f'<a href="{YT_CHANNEL}" target="_blank" rel="noopener">YouTube</a></p>')

# ---------------------------------------------------------------- YouTube feed
ns = {'a': 'http://www.w3.org/2005/Atom', 'yt': 'http://www.youtube.com/xml/schemas/2015', 'media': 'http://search.yahoo.com/mrss/'}
feed = ET.fromstring(urllib.request.urlopen(f'https://www.youtube.com/feeds/videos.xml?channel_id={CHANNEL}', timeout=30).read())
episodes = {}
for e in feed.findall('a:entry', ns):
    vid = e.find('yt:videoId', ns).text; title = e.find('a:title', ns).text
    m = re.search(r'Episode\s+(\d+)', title)
    if vid in SKIP_VIDEO_IDS or not m: continue
    episodes[vid] = {'n': int(m.group(1)), 'ytTitle': title, 'published': e.find('a:published', ns).text,
                     'desc': e.find('media:group/media:description', ns).text or ''}

def thumb(vid):
    for q in ('maxresdefault', 'hqdefault'):
        u = f'https://i.ytimg.com/vi/{vid}/{q}.jpg'
        try:
            r = urllib.request.urlopen(u, timeout=20)
            if r.status == 200: return u
        except Exception: pass
    return None

# Titles + categories for episodes that have no Wix post (written 2026-10-21, editorial style of eps 1-6).
NEW_EPISODES = {
    7: {'title': 'Building an Ecosystem from the Ground Up: The Lean Rocket Lab Team', 'cats': [PODCAST_CAT, 'LRL News'],
        'slug': 'building-an-ecosystem-from-the-ground-up-the-lean-rocket-lab-team'},
    8: {'title': 'From Video Production to Downtown Developer: Jake Cross of Uncharted Film Co', 'cats': [PODCAST_CAT, 'Mainstreet'],
        'slug': 'from-video-production-to-downtown-developer-jake-cross-of-uncharted-film-co'},
    9: {'title': 'No Plan, All Parachute: How Bart Hawley Built JTV', 'cats': [PODCAST_CAT, 'LOCAL'],
        'slug': 'no-plan-all-parachute-how-bart-hawley-built-jtv'},
}

def clean_copy(s):
    s = re.sub(r'\s*\u2014\s*', ', ', s).replace(',,', ',')  # brand rule: no em dashes
    s = s.replace('25 years of daily programming, then you win.', '25 years of daily programming, this episode is for you.')
    return s

def desc_html(desc):
    out = []
    for block in re.split(r'\n\s*\n', desc.strip()):
        lines = [l.strip() for l in block.split('\n') if l.strip()]
        if not lines: continue
        if re.match(r'^(Connect with|Website:|LinkedIn:|Facebook:|Instagram:|TikTok:|YouTube:|Don.t miss|Watch and listen|Apple Podcasts:|Spotify)', lines[0]):
            continue  # channel boilerplate; replaced by listen_block()
        bullets = [l for l in lines if l.startswith('•')]
        head = [l for l in lines if not l.startswith('•')]
        for l in head: out.append(f'<p>{esc(clean_copy(l))}</p>')
        if bullets: out.append('<ul>' + ''.join(f'<li>{esc(clean_copy(b.lstrip("• ")))}</li>' for b in bullets) + '</ul>')
    return '\n'.join(out)

# ---------------------------------------------------------------- build
plan = []
wix_by_vid = {}
for p in EXPORT['posts']:
    cats = [cat_label[c] for c in p.get('categoryIds', []) if c in cat_label]
    images = []
    h = body_html(p, images)
    media = p.get('media') or {}
    vid = yt_id(((media.get('embedMedia') or {}).get('video') or {}).get('url', ''))
    is_pod = PODCAST_CAT in cats
    if not cats: cats = ['Readiness Scales']
    cover = None
    if (media.get('wixMedia') or {}).get('image'):
        im = media['wixMedia']['image']
        cover = {'source': f"https://static.wixstatic.com/media/{im['id']}/v1/fit/w_1920,h_1920,q_85/{im['id']}", 'alt': p['title']}
    elif vid:
        cover = {'source': thumb(vid), 'alt': p['title']}
    entry = {
        'key': 'wix:' + p['id'], 'blog': 'podcast' if is_pod else 'blog', 'title': p['title'], 'slug': p['slug'],
        'description': (p.get('excerpt') or '').strip()[:300], 'publishedAt': p['firstPublishedDate'],
        'categories': cats, 'tags': [tag_label[t] for t in p.get('tagIds', []) if t in tag_label] + [x for x in (p.get('hashtags') or [])],
        'cover': cover or {'generate': True, 'alt': p['title']}, 'inlineImages': images,
        'oldUrl': (p.get('url') or {}).get('base', '') + (p.get('url') or {}).get('path', ''), 'readTime': p.get('minutesToRead'),
    }
    if is_pod:
        ep = episodes.get(vid)
        if ep:
            entry['tags'].append(f"Episode {ep['n']}"); entry['episode'] = ep['n']; wix_by_vid[vid] = entry
        if vid and 'youtube.com/embed/' + vid not in h:
            h = yt_embed(vid, p['title']) + '\n' + h
        h += '\n' + listen_block()
    entry['html'] = h; entry['wordCount'] = words(h)
    plan.append(entry)

for vid, ep in sorted(episodes.items(), key=lambda kv: kv[1]['n']):
    if vid in wix_by_vid: continue
    meta = NEW_EPISODES.get(ep['n'])
    if not meta: raise SystemExit(f"episode {ep['n']} ({vid}) has no Wix post and no NEW_EPISODES entry")
    h = yt_embed(vid, meta['title']) + '\n' + desc_html(ep['desc']) + '\n' + listen_block()
    first = re.sub(r'<[^>]+>', '', desc_html(ep['desc']).split('</p>')[0])
    plan.append({'key': 'yt:' + vid, 'blog': 'podcast', 'title': meta['title'], 'slug': meta['slug'],
                 'description': html.unescape(first)[:297].rsplit(' ', 1)[0] + '...' if len(first) > 300 else html.unescape(first),
                 'publishedAt': ep['published'], 'categories': meta['cats'], 'tags': [f"Episode {ep['n']}"],
                 'cover': {'source': thumb(vid), 'alt': meta['title']}, 'inlineImages': [], 'oldUrl': None,
                 'episode': ep['n'], 'html': h, 'wordCount': words(h), 'readTime': None})

for e in plan:
    if not e.get('readTime'): e['readTime'] = max(1, round(e['wordCount'] / 230))

# ---------------------------------------------------------------- branded covers
BG, GOLD, TEAL, WHITE = (23, 23, 23), (248, 185, 50), (5, 153, 140), (255, 255, 255)
FB = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
FR = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
LOGO = Image.open(os.path.join(ROOT, 'assets', 'lrl-logo-horizontal-white.png')).convert('RGBA')
os.makedirs(os.path.join(ROOT, 'covers'), exist_ok=True)

def wrap(draw, text, font, width):
    lines, cur = [], ''
    for w in text.split():
        t = (cur + ' ' + w).strip()
        if draw.textlength(t, font=font) <= width: cur = t
        else: lines.append(cur); cur = w
    lines.append(cur); return lines

def make_cover(e):
    W, H = 1600, 900
    img = Image.new('RGB', (W, H), BG); d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 24, H], fill=GOLD)
    d.text((120, 120), e['categories'][0].upper(), font=ImageFont.truetype(FB, 34), fill=TEAL)
    size = 84
    while True:
        f = ImageFont.truetype(FB, size); lines = wrap(d, e['title'], f, W - 240)
        if len(lines) <= 4 or size <= 52: break
        size -= 6
    y = 190
    for l in lines[:5]:
        d.text((120, y), l, font=f, fill=WHITE); y += int(size * 1.18)
    d.rectangle([120, y + 24, 260, y + 30], fill=GOLD)
    lw = 380; lh = round(LOGO.height * lw / LOGO.width)  # one dimension set; ratio preserved
    img.paste(LOGO.resize((lw, lh), Image.LANCZOS), (120, H - 90 - lh), LOGO.resize((lw, lh), Image.LANCZOS))
    path = os.path.join(ROOT, 'covers', e['slug'][:80] + '.png'); img.save(path, optimize=True)
    return path

for e in plan:
    if e['cover'].get('generate'):
        e['cover']['file'] = make_cover(e)

json.dump(plan, open(os.path.join(ROOT, 'plan.json'), 'w'), indent=2)
blog = [e for e in plan if e['blog'] == 'blog']; pod = sorted([e for e in plan if e['blog'] == 'podcast'], key=lambda e: e.get('episode', 0))
print(f'plan: {len(blog)} blog posts, {len(pod)} podcast episodes, '
      f'{sum(1 for e in plan if e["cover"].get("generate"))} generated covers, {sum(len(e["inlineImages"]) for e in plan)} inline images')
for e in pod: print(f"  ep {e.get('episode')}: {e['title']} | cover={'yes' if e['cover'].get('source') else 'MISSING'}")
print('em dashes left in migrated copy:', sum(e['html'].count('—') for e in plan))
