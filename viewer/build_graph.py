#!/usr/bin/env python3
"""
Build graph.json and the self-contained zfs-io-flow.html from the spec.

Usage (from the viewer directory):
    python3 build_graph.py --suite suite.json      (every page plus index.html)
    python3 build_graph.py [--spec ../zfs-io-flow-diagram-spec.md]
                           [--repo ../zfs] [--out .]   (one page)

The spec is the only source of content. The OpenZFS checkout is read to
embed the text of every referenced source line (spec section 4.11).
"""

import argparse
import html
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def read_lines(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read().splitlines()


def section_lines(lines, start_prefix, stop_prefix):
    """Return the lines after the first line starting with start_prefix,
    up to (not including) the next line starting with stop_prefix."""
    result = []
    inside = False
    for line in lines:
        if line.startswith(start_prefix):
            inside = True
            continue
        if inside and line.startswith(stop_prefix):
            break
        if inside:
            result.append(line)
    return result


def table_rows(lines):
    """Split markdown table rows into stripped cells, skipping the header
    and the separator row."""
    rows = []
    for line in lines:
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if set(cells[0]) <= set("-: "):
            continue
        rows.append(cells)
    return rows[1:] if rows else rows


def unquote(text):
    return text.strip().strip("`")


def code_names(text):
    return re.findall(r"`([^`]+)`", text)


# ----------------------------------------------------------------------
# Parsers, one per spec section


def parse_meta(lines):
    meta = {"repo": "https://github.com/openzfs/zfs"}
    for line in lines:
        match = re.search(r"at commit `([0-9a-f]{40})`.*version ([0-9.]+)", line)
        if match:
            meta["commit"] = match.group(1)
            meta["version"] = match.group(2)
            break
    for line in lines:
        match = re.search(r"Show this table in the details panel of `(\w+)`", line)
        if match:
            meta["pipelineNode"] = match.group(1)
    if "commit" not in meta:
        sys.exit("could not find the pinned commit in the spec")
    return meta


def parse_types(lines):
    types = []
    for cells in table_rows(section_lines(lines, "### 6.1", "### 6.2")):
        types.append({
            "id": unquote(cells[0]),
            "color": unquote(cells[1]),
            "name": cells[2],
            "desc": cells[3],
        })
    return types


def parse_contexts(lines):
    contexts = []
    for cells in table_rows(section_lines(lines, "### 6.2", "## 7.")):
        contexts.append({"id": unquote(cells[0]), "name": cells[1]})
    return contexts


def parse_groups(lines):
    groups = []
    for cells in table_rows(section_lines(lines, "## 7.", "Default layout rules")):
        groups.append({
            "id": unquote(cells[0]),
            "title": cells[1],
            "color": unquote(cells[2]),
            "col": int(cells[3]),
            "band": cells[4],
            "subcols": int(cells[5]),
            "count": int(cells[6]),
            "summary": cells[7],
        })
    return groups


def split_role(text):
    """Split 'role. Tunables: `a`, `b`. Properties: `c`.' into parts."""
    role = text
    tunables = []
    props = []
    match = re.search(r"\s*Properties:\s*(.*)$", role)
    if match:
        props = code_names(match.group(1))
        role = role[:match.start()]
    match = re.search(r"\s*Tunables:\s*(.*)$", role)
    if match:
        tunables = code_names(match.group(1))
        role = role[:match.start()]
    return role.strip(), tunables, props


def parse_nodes(lines):
    nodes = []
    group_id = None
    for line in section_lines(lines, "## 8.", "## 9."):
        match = re.match(r"^### 8\.\d+ .*\(`(\w+)`\)", line)
        if match:
            group_id = match.group(1)
            continue
        if not line.startswith("| `"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        role_text = " | ".join(cells[6:])
        role, tunables, props = split_role(role_text)
        source = unquote(cells[4])
        nodes.append({
            "id": unquote(cells[0]),
            "group": group_id,
            "sub": int(cells[2]),
            "title": cells[1],
            "ctx": unquote(cells[3]),
            "src": "" if source == "-" else source,
            "fnNames": code_names(cells[5]),
            "role": role,
            "tunableNames": tunables,
            "propNames": props,
        })
    return nodes


def parse_wires(lines):
    wires = []
    pattern = re.compile(
        r"^\| (E\d{3}) \| `(\w+)` \| `(\w+)` \| `(\w+)` \| (.*) \| (.*) \|$")
    for line in section_lines(lines, "## 9.", "## 10."):
        match = pattern.match(line)
        if match:
            wires.append({
                "id": match.group(1),
                "from": match.group(2),
                "to": match.group(3),
                "type": match.group(4),
                "label": match.group(5).strip(),
                "listedPaths": [p.strip() for p in match.group(6).split(",")],
            })
    return wires


def parse_alternative(line):
    """'- `layout`: `mirror` Mirror ...; `raidz` RAIDZ ...' -> group dict."""
    match = re.match(r"^- `(\w+)`: (.*)$", line)
    if not match:
        return None
    options = []
    for part in match.group(2).split(";"):
        option = re.match(r"\s*`(\w+)`\s*(.*)$", part)
        if option:
            options.append({"id": option.group(1), "label": option.group(2).strip()})
    return {"id": match.group(1), "options": options}


STEP_PATTERN = re.compile(
    r"^\s*(\d+)\s+(E\d{3})\s+(\w+) -> (\w+)((?:\s+\[[^\]]+\])*)(?:\s+\"(.*)\")?\s*$")


def parse_paths(lines):
    paths = []
    path = None
    in_code = False
    in_alts = False
    for line in section_lines(lines, "## 10.", "## 11."):
        match = re.match(r"^### 10\.\d+ `(\w+)` - (.*)$", line)
        if match:
            path = {"id": match.group(1), "title": match.group(2).strip(),
                    "category": "", "summary": "", "ends": "",
                    "alts": [], "steps": []}
            paths.append(path)
            in_alts = False
            continue
        if path is None:
            continue
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            step = STEP_PATTERN.match(line)
            if not step:
                if line.strip():
                    sys.exit("bad step line in path %s: %s" % (path["id"], line))
                continue
            entry = {"wire": step.group(2), "from": step.group(3), "to": step.group(4)}
            when = []
            for group, options in re.findall(r"\[(\w+): ([^\]]+)\]", step.group(5) or ""):
                when.append({"group": group,
                             "options": [o.strip() for o in options.split(",")]})
            if when:
                entry["when"] = when
            if step.group(6):
                entry["note"] = step.group(6)
            entry["n"] = int(step.group(1))
            path["steps"].append(entry)
            continue
        if line.startswith("Category: "):
            body = line[len("Category: "):]
            category, _, summary = body.partition(". ")
            path["category"] = category.strip()
            path["summary"] = summary.strip()
            continue
        if line.startswith("Alternatives:"):
            in_alts = True
            continue
        if in_alts:
            group = parse_alternative(line)
            if group:
                path["alts"].append(group)
                continue
            in_alts = False
        if line.startswith("Ends: "):
            path["ends"] = line[len("Ends: "):].strip()
    return paths


def parse_numbered(lines):
    items = []
    for line in lines:
        match = re.match(r"^\d+\. (.*)$", line)
        if match:
            items.append(match.group(1).strip())
    return items


def parse_about(lines):
    model = parse_numbered(section_lines(lines, "### Mental model", "### Scope"))
    simplifications = parse_numbered(
        section_lines(lines, "Simplifications made on purpose", "## 12."))
    return {"model": model, "simplifications": simplifications}


def parse_index(lines, start_prefix, stop_prefix, with_symbol):
    """Parse 'key  file:line  [symbol]' lines from an appendix code block.

    Every non-empty line inside the appendix's fenced block must match, so a
    malformed reference (for example a symbol containing a space) stops the
    build instead of being dropped."""
    entries = []
    in_code = False
    for line in section_lines(lines, start_prefix, stop_prefix):
        if line.startswith("```"):
            in_code = not in_code
            continue
        if not in_code or not line.strip():
            continue
        if with_symbol:
            match = re.match(r"^(\S+)\s+(\S+):(\d+)\s+(\S+)$", line)
        else:
            match = re.match(r"^(\S+)\s+(\S+):(\d+)$", line)
        if not match:
            sys.exit("%s: malformed reference line (symbols must be one token): %s" % (
                start_prefix.lstrip("# "), line))
        entry = {"key": match.group(1), "file": match.group(2),
                 "line": int(match.group(3))}
        entry["symbol"] = match.group(4) if with_symbol else match.group(1)
        entries.append(entry)
    return entries


TIMELINE_STEP = re.compile(r'^STEP (\d+) txg=(\d+) "([^"]*)"(.*)$')
TIMELINE_DS = re.compile(r"^DS (\S+) (head|snapshot|bookmark|clone)(.*)$")
TIMELINE_BLK = re.compile(r"^BLK (\S+) birth=(\d+)(.*)$")
TIMELINE_NOTE = re.compile(r'^NOTE "(.*)"$')


def key_values(text):
    return dict(re.findall(r"(\w+)=(\S+)", text))


def parse_timelines(lines):
    """Parse Appendix E (suite spec section 6) into a list of scenarios."""
    scenarios = []
    scenario = None
    in_code = False
    for line in section_lines(lines, "## Appendix E", "\x00"):
        match = re.match(r"^### E\.\d+ `(\w+)` - (.*)$", line)
        if match:
            scenario = {"id": match.group(1), "title": match.group(2).strip(),
                        "summary": "", "steps": []}
            scenarios.append(scenario)
            in_code = False
            continue
        if scenario is None:
            continue
        if line.startswith("```"):
            in_code = not in_code
            continue
        text = line.strip()
        if not in_code:
            if text and not scenario["steps"]:
                scenario["summary"] = (scenario["summary"] + " " + text).strip()
            continue
        if not text:
            continue
        step_match = TIMELINE_STEP.match(text)
        if step_match:
            attrs = key_values(step_match.group(4))
            path_id, _, path_step = attrs.get("path", "").partition("@")
            scenario["steps"].append({
                "n": int(step_match.group(1)),
                "txg": int(step_match.group(2)),
                "caption": step_match.group(3),
                "path": path_id or None,
                "pathStep": int(path_step) if path_step else None,
                "wires": [w for w in attrs.get("wires", "").split(",") if w],
                "notes": [], "datasets": [], "blocks": [],
            })
            continue
        if not scenario["steps"]:
            sys.exit("timeline %s: line before the first STEP: %s" % (scenario["id"], text))
        step = scenario["steps"][-1]
        ds_match = TIMELINE_DS.match(text)
        blk_match = TIMELINE_BLK.match(text)
        note_match = TIMELINE_NOTE.match(text)
        if ds_match:
            attrs = key_values(ds_match.group(3))
            step["datasets"].append({
                "name": ds_match.group(1), "kind": ds_match.group(2),
                "prev": attrs.get("prev"), "txg": int(attrs["txg"]) if "txg" in attrs else None,
                "origin": attrs.get("origin"),
            })
        elif blk_match:
            attrs = key_values(blk_match.group(3))
            step["blocks"].append({
                "id": blk_match.group(1), "birth": int(blk_match.group(2)),
                "in": [d for d in attrs.get("in", "").split(",") if d],
                "dead": attrs.get("dead"), "state": attrs.get("state", "live"),
            })
        elif note_match:
            step["notes"].append(note_match.group(1))
        else:
            sys.exit("timeline %s: cannot parse line: %s" % (scenario["id"], text))
    return scenarios


def parse_title(lines):
    for line in lines:
        match = re.match(r"^# (.*?)(?: \(build spec\))?$", line)
        if match:
            return match.group(1).strip()
    return "ZFS"


def parse_intro(lines):
    """First paragraph after the H1 title, for the suite index."""
    seen_title = False
    for line in lines:
        if line.startswith("# "):
            seen_title = True
            continue
        if seen_title and line.strip():
            return line.strip()
    return ""


def parse_pipelines(lines):
    block = section_lines(lines, "## Appendix B", "## Appendix C")
    stages = []
    pipelines = []
    mode = None
    for line in block:
        if line.startswith("Stage order"):
            mode = "stages"
            continue
        if line.startswith("Pipelines (stages"):
            mode = "pipelines"
            continue
        if not line.startswith("|") or line.startswith("|---") or line.startswith("| #") \
                or line.startswith("| pipeline"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if mode == "stages":
            node = unquote(cells[3])
            stages.append({"name": cells[1], "fn": unquote(cells[2]),
                           "node": node if re.match(r"^\w+$", node) else None,
                           "note": "" if re.match(r"^\w+$", node) else cells[3]})
        elif mode == "pipelines":
            pipelines.append({"name": cells[0], "usedFor": cells[1], "text": cells[2]})
    order = [stage["name"] for stage in stages]
    by_name = {}
    for pipe in pipelines:
        text = pipe["text"]
        note = ""
        match = re.search(r"\((.*)\)", text)
        if match:
            note = match.group(1)
            text = text[:match.start()].strip()
        base = re.match(r"^(ZIO_\w+_PIPELINE)\b(.*)$", text)
        if base:
            names = list(by_name[base.group(1)])
            rest = base.group(2)
            minus = re.match(r"\s*without (.*)$", rest)
            plus = re.match(r"\s*plus (.*)$", rest)
            if minus:
                for name in re.findall(r"[A-Z_]+", minus.group(1)):
                    if name in names:
                        names.remove(name)
            if plus:
                for name in re.findall(r"[A-Z][A-Z_]+", plus.group(1)):
                    if name in order and name not in names:
                        names.append(name)
        else:
            names = [n.strip() for n in text.split(",") if n.strip() in order]
        names.sort(key=order.index)
        pipe["stages"] = names
        pipe["note"] = note
        by_name[pipe["name"]] = names
    runtime = ""
    for line in block:
        if line.startswith("Additions made at run time"):
            runtime = line.split(":", 1)[1].strip()
    return stages, pipelines, runtime


# ----------------------------------------------------------------------
# Source line text from the checkout

class SourceReader:
    def __init__(self, repo):
        self.repo = repo
        self.cache = {}
        self.problems = []

    def line(self, path, number):
        if path not in self.cache:
            full = os.path.join(self.repo, path)
            if not os.path.exists(full):
                self.cache[path] = None
            else:
                with open(full, encoding="utf-8", errors="replace") as handle:
                    self.cache[path] = handle.read().splitlines()
        text = self.cache[path]
        if text is None or number < 1 or number > len(text):
            self.problems.append("%s:%d does not exist" % (path, number))
            return ""
        return text[number - 1].strip()

    def ref(self, path, number, symbol):
        code = self.line(path, number)
        if code and symbol not in code:
            self.problems.append("%s:%d does not contain %s" % (path, number, symbol))
        return {"file": path, "line": number, "symbol": symbol, "code": code}


# ----------------------------------------------------------------------


def build(spec_path, repo_path):
    lines = read_lines(spec_path)
    reader = SourceReader(repo_path)

    meta = parse_meta(lines)
    # Each appendix ends at the next "## Appendix" heading (or the end of file).
    fn_index = {e["key"]: e for e in parse_index(
        lines, "## Appendix A", "## Appendix", with_symbol=False)}
    wire_refs = {}
    for entry in parse_index(lines, "## Appendix C", "## Appendix", with_symbol=True):
        wire_refs.setdefault(entry["key"], []).append(
            reader.ref(entry["file"], entry["line"], entry["symbol"]))
    name_refs = {}
    for entry in parse_index(lines, "## Appendix D", "## Appendix", with_symbol=True):
        name_refs[entry["key"]] = reader.ref(entry["file"], entry["line"], entry["symbol"])

    nodes = []
    for raw in parse_nodes(lines):
        fns = []
        for name in raw["fnNames"]:
            where = fn_index.get(name)
            ref = reader.ref(where["file"], where["line"], name) if where else None
            fns.append({"name": name, "ref": ref})
        tunables = [{"name": n, "ref": name_refs.get(n)} for n in raw["tunableNames"]]
        props = [{"name": n, "ref": name_refs.get(n)} for n in raw["propNames"]]
        nodes.append({
            "id": raw["id"], "group": raw["group"], "sub": raw["sub"],
            "title": raw["title"], "ctx": raw["ctx"], "src": raw["src"],
            "fns": fns, "role": raw["role"], "tunables": tunables, "props": props,
        })

    wires = []
    for raw in parse_wires(lines):
        wires.append({
            "id": raw["id"], "from": raw["from"], "to": raw["to"],
            "type": raw["type"], "label": raw["label"],
            "refs": wire_refs.get(raw["id"], []),
        })

    paths = []
    for raw in parse_paths(lines):
        steps = []
        for step in raw["steps"]:
            clean = {"wire": step["wire"]}
            if "when" in step:
                clean["when"] = step["when"]
            if "note" in step:
                clean["note"] = step["note"]
            steps.append(clean)
        paths.append({
            "id": raw["id"], "category": raw["category"], "title": raw["title"],
            "summary": raw["summary"], "ends": raw["ends"],
            "alts": raw["alts"], "steps": steps,
        })

    stages, pipelines, runtime = parse_pipelines(lines)

    graph = {
        "meta": meta,
        "types": parse_types(lines),
        "contexts": parse_contexts(lines),
        "groups": [{k: v for k, v in g.items() if k != "count"} for g in parse_groups(lines)],
        "nodes": nodes,
        "wires": wires,
        "paths": paths,
        "stages": stages,
        "pipelines": [{"name": p["name"], "usedFor": p["usedFor"],
                       "stages": p["stages"], "note": p["note"]} for p in pipelines],
        "pipelineRuntimeNote": runtime,
        "about": parse_about(lines),
        "timelines": parse_timelines(lines),
        "page": {"id": "zfs-io-flow", "title": "ZFS I/O Flow", "file": "zfs-io-flow.html",
                 "intro": parse_intro(lines)},
        "suite": None,
    }
    return graph, reader.problems


def write_page(graph, out_dir):
    src_dir = os.path.join(HERE, "src")
    with open(os.path.join(src_dir, "template.html"), encoding="utf-8") as handle:
        template = handle.read()
    with open(os.path.join(src_dir, "style.css"), encoding="utf-8") as handle:
        style = handle.read()
    with open(os.path.join(src_dir, "app.js"), encoding="utf-8") as handle:
        script = handle.read()
    data = json.dumps(graph, separators=(",", ":"), ensure_ascii=False)
    data = data.replace("</", "<\\/")
    page = template.replace("/*{{STYLE}}*/", style)
    page = page.replace("{{GRAPH}}", data)
    page = page.replace("/*{{SCRIPT}}*/", script)
    page = page.replace("{{COMMIT}}", graph["meta"]["commit"])
    page = page.replace("{{TITLE}}", html.escape(graph["page"]["title"]))
    with open(os.path.join(out_dir, graph["page"]["file"]), "w", encoding="utf-8") as handle:
        handle.write(page)
    return len(page.encode("utf-8"))


def write_json(graph, path):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(graph, handle, indent=1, ensure_ascii=False)
        handle.write("\n")


def load_manifest(path):
    """suite.json -> list of pages with absolute spec paths."""
    with open(path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    base = os.path.dirname(os.path.abspath(path))
    pages = []
    for page in manifest["pages"]:
        entry = dict(page)
        entry["specPath"] = os.path.normpath(os.path.join(base, page["spec"]))
        pages.append(entry)
    return pages


def build_suite(manifest_path, repo, out_dir):
    """Build every page of the suite and index.html. Returns the problems."""
    pages = load_manifest(manifest_path)
    graphs = []
    problems = []
    for page in pages:
        graph, page_problems = build(page["specPath"], repo)
        problems.extend("%s: %s" % (page["id"], p) for p in page_problems)
        graph["page"].update({"id": page["id"], "title": page["title"], "file": page["file"]})
        graphs.append(graph)

    # For every node id, the pages that contain it.
    pages_by_node = {}
    for page, graph in zip(pages, graphs):
        for node in graph["nodes"]:
            pages_by_node.setdefault(node["id"], []).append(page["id"])
    listing = [{"id": p["id"], "title": p["title"], "file": p["file"]} for p in pages]
    for page, graph in zip(pages, graphs):
        also = {}
        for node in graph["nodes"]:
            others = [pid for pid in pages_by_node[node["id"]] if pid != page["id"]]
            if others:
                also[node["id"]] = others
        graph["suite"] = {"pages": listing, "alsoIn": also}

    sizes = []
    for page, graph in zip(pages, graphs):
        stem = os.path.splitext(page["file"])[0]
        write_json(graph, os.path.join(out_dir, stem + ".json"))
        if page["id"] == "zfs-io-flow":
            write_json(graph, os.path.join(out_dir, "graph.json"))
        sizes.append(write_page(graph, out_dir))
    write_index(pages, graphs, out_dir)
    for page, graph, size in zip(pages, graphs, sizes):
        print("%-28s nodes %3d, wires %3d, paths %2d, timelines %d, page %d bytes" % (
            page["file"], len(graph["nodes"]), len(graph["wires"]), len(graph["paths"]),
            len(graph["timelines"]), size))
    return problems


def write_index(pages, graphs, out_dir):
    """Suite landing page: one card per page (spec section 2 of the suite spec)."""
    with open(os.path.join(HERE, "src", "index.html"), encoding="utf-8") as handle:
        template = handle.read()
    cards = []
    for page, graph in zip(pages, graphs):
        counts = "%d nodes, %d wires, %d paths" % (
            len(graph["nodes"]), len(graph["wires"]), len(graph["paths"]))
        if graph["timelines"]:
            counts += ", %d timelines" % len(graph["timelines"])
        intro = page.get("summary") or re.sub(r"`([^`]*)`", r"\1", graph["page"]["intro"])
        cards.append(
            '<a class="card" href="%s"><h2>%s</h2><p>%s</p><p class="counts">%s</p></a>' % (
                html.escape(page["file"]), html.escape(page["title"]),
                html.escape(intro), html.escape(counts)))
    meta = graphs[0]["meta"]
    page_html = template.replace("{{CARDS}}", "\n".join(cards))
    page_html = page_html.replace("{{COMMIT}}", meta["commit"])
    page_html = page_html.replace("{{REPO}}", meta["repo"])
    page_html = page_html.replace("{{VERSION}}", meta["version"])
    with open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8") as handle:
        handle.write(page_html)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--spec", default=os.path.join(HERE, "..", "zfs-io-flow-diagram-spec.md"))
    parser.add_argument("--suite", help="build every page listed in this manifest (suite.json)")
    parser.add_argument("--repo", default=os.path.join(HERE, "..", "zfs"))
    parser.add_argument("--out", default=HERE)
    args = parser.parse_args()

    if args.suite:
        problems = build_suite(args.suite, args.repo, args.out)
        for problem in problems:
            print("source reference problem:", problem, file=sys.stderr)
        sys.exit(1 if problems else 0)

    graph, problems = build(args.spec, args.repo)
    for problem in problems:
        print("source reference problem:", problem, file=sys.stderr)
    write_json(graph, os.path.join(args.out, "graph.json"))
    size = write_page(graph, args.out)
    print("nodes %d, wires %d, paths %d, page %d bytes" % (
        len(graph["nodes"]), len(graph["wires"]), len(graph["paths"]), size))
    if problems:
        sys.exit(1)


if __name__ == "__main__":
    main()
