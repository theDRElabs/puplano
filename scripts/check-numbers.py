import json, re, sys
W = dict(one=1, two=2, three=3, four=4, five=5, six=6, seven=7, eight=8, nine=9, ten=10, twenty=20, hundred=100, thousand=1000, million=10**6, billion=10**9)
SKIP = {"license", "imageFile", "videoFile", "startFromMs", "decimals"}

def nums(text):
    out = set()
    for m in re.findall(r"\d[\d,]*\.?\d*", text):
        out.add(float(m.replace(",", "").rstrip(".")))
    for w in re.findall(r"[a-z]+", text.lower()):
        if w in W: out.add(float(W[w]))
    return out

def walk(x):
    if isinstance(x, dict):
        for k, v in x.items():
            if k not in SKIP: yield from walk(v)
    elif isinstance(x, list):
        for v in x: yield from walk(v)
    elif isinstance(x, bool):
        return
    elif isinstance(x, (int, float)):
        yield float(x)
    elif isinstance(x, str):
        yield from nums(x)

base = "projects/" + sys.argv[1]
ok = nums(open(base + "/script/script.md").read()) | {0.0}
sb = json.load(open(base + "/storyboard/storyboard.json"))
items = [(s["id"], s["props"]) for s in sb["scenes"]]
items += [(o["id"], o["text"]) for o in sb["overlays"]]
bad = 0
for i, x in items:
    for n in sorted(set(walk(x))):
        if n not in ok:
            print("NOT IN SCRIPT:", i, n)
            bad += 1
print("FAILED" if bad else "NUMBERS OK", bad)
sys.exit(1 if bad else 0)
